import * as sandcastle from "@ai-hero/sandcastle";
import type { OutputObjectDefinition, RunOptions, RunResult } from "@ai-hero/sandcastle";

/**
 * The agent driver: everything that loads the agent SDK, and the one module
 * under `shared/` that does. A runner starts the agent through here; a command
 * starts none, and `tests/agent-cli.test.ts` walks each command's imports and
 * fails if they reach this module (ADR 0004), so the SDK is never loaded in a
 * process holding the loop's write token. A helper that only reads GitHub or
 * the environment belongs in `shared/common.ts`, which must not import this.
 */

/**
 * The model agents run on unless something overrides it. Pinned deliberately
 * rather than floating: the same reasoning as `.nvmrc` — the runner, CI and a
 * local run must not silently drift onto different versions. Bumping it is a
 * decision, so it gets a commit or a variable change.
 */
const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Per-workflow defaults, listed only where they differ from `DEFAULT_MODEL`.
 *
 * `update-branch` is the one mechanical job in the set: the workflow merges in
 * bash and only wakes the agent when git reports a conflict, so the task is
 * "reconcile two known texts" rather than "design something". Sonnet is sized
 * for that.
 *
 * Caveat worth keeping visible — the one real conflict this has resolved was
 * *not* purely mechanical (see friction.md, 2026-07-25): a naive "preserve both
 * sides" merge would have re-listed shipped features as future work, and the
 * agent avoided that by noticing what had actually shipped. If a future
 * conflict is resolved badly, this row is the first thing to suspect; raise it
 * by setting AGENT_MODEL_UPDATE_BRANCH rather than editing code.
 */
const WORKFLOW_MODELS: Record<string, string> = {
  "update-branch": "claude-sonnet-5-5",
};

/** Workflow name → the env var that overrides it. `update-branch` → `AGENT_MODEL_UPDATE_BRANCH`. */
export const overrideVar = (workflow: string): string =>
  `AGENT_MODEL_${workflow.toUpperCase().replace(/-/g, "_")}`;

/**
 * Resolve the model, most specific wins:
 *
 *   AGENT_MODEL_<WORKFLOW>  → this workflow only
 *   AGENT_MODEL             → every workflow, including ones with a per-workflow
 *                             default; "run everything on X" is the whole point
 *                             of setting it, so it deliberately outranks the
 *                             table above
 *   WORKFLOW_MODELS         → the baked per-workflow default
 *   DEFAULT_MODEL           → everything else
 *
 * `||` rather than `??` throughout: GitHub interpolates an **unset** `vars.X`
 * into the empty string, not into nothing, so on any repo that has not set the
 * variable the env var arrives as `""`. `??` would pass that straight through
 * and hand the CLI an empty model id.
 */
interface ResolvedModel {
  readonly model: string;
  /** Which rung of the chain won, for the log line. */
  readonly source: string;
}

/**
 * The ordering lives here **once**. It previously existed twice — once to pick
 * the model and once to name the winner for the log — which meant reordering
 * one and not the other would have the log confidently report the wrong source.
 * A log that lies about provenance is worse than no log, and nothing would have
 * caught it: the naming half was unexported and untestable.
 */
const resolveModel = (workflow: string, inputs: ModelInputs): ResolvedModel => {
  const perWorkflowOverride = inputs[overrideVar(workflow)];
  if (perWorkflowOverride) return { model: perWorkflowOverride, source: overrideVar(workflow) };

  const globalOverride = inputs["AGENT_MODEL"];
  if (globalOverride) return { model: globalOverride, source: "AGENT_MODEL" };

  const perWorkflowDefault = WORKFLOW_MODELS[workflow];
  if (perWorkflowDefault) return { model: perWorkflowDefault, source: `${workflow} default` };

  return { model: DEFAULT_MODEL, source: "default" };
};

/**
 * The inputs the chain above reads, by the names a runner declares them under
 * in `shared/contract.ts`: its `AGENT_MODEL_<WORKFLOW>` and `AGENT_MODEL`. The
 * runner reads them and hands them in; nothing here reads the environment.
 */
export type ModelInputs = Readonly<Record<string, string>>;

export const agentModel = (workflow: string, inputs: ModelInputs): string => resolveModel(workflow, inputs).model;

/**
 * @param workflow Directory name under `agent-workflows/` — `implement`,
 *   `fix`, `review`, `update-branch`. Drives model selection, so it
 *   must match the directory or the workflow silently gets the global default.
 * @param inputs The runner's inputs, as `readInputs` read them: the model
 *   token, and the model's two overrides.
 */
export const claudeAgent = (
  workflow: string,
  inputs: ModelInputs & { readonly AGENT_MODEL: string; readonly CLAUDE_CODE_OAUTH_TOKEN: string },
) => {
  const { model, source } = resolveModel(workflow, inputs);
  // Echoed so a run is self-documenting — "which model produced this?" is the
  // first question asked of any output that looks off, and the answer should
  // not require knowing what a repository variable was set to that week.
  console.log(`Agent model: ${model} (${source})`);
  return sandcastle.claudeCode(model, {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: inputs.CLAUDE_CODE_OAUTH_TOKEN,
    },
  });
};

export interface RunWithExtractionOptions<T> extends Omit<RunOptions, "output"> {
  readonly output: OutputObjectDefinition<T>;
  readonly extractionPrompt: string;
  /**
   * Extra attempts after the first if extraction or validation fails. Forwarded
   * to `Output`'s built-in `maxRetries`, which resumes the extraction session
   * and feeds the error back so the agent can re-emit a corrected tag.
   */
  readonly maxRetries?: number;
}

/**
 * Two-phase run: let the agent do the work in a normal session, then resume
 * that same session with a second prompt whose only job is to emit the
 * structured `<output>` block. Separating "think" from "format" keeps the model
 * from truncating its reasoning to fit a schema, and the resume means the
 * extractor sees everything the worker just did.
 */
export async function runWithExtraction<T>(
  options: RunWithExtractionOptions<T>,
): Promise<RunResult & { output: T }> {
  const { output, extractionPrompt, maxRetries = 2, ...produceOptions } = options;
  const produce = await sandcastle.run(produceOptions);
  const sessionId = produce.iterations.at(-1)?.sessionId;

  if (!sessionId) {
    throw new Error("Cannot extract structured output: the produce run had no session id.");
  }

  // Drop `promptArgs`, `promptFile` and `name` from the spread rather than
  // reassigning them to `undefined` — `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, so they must be omitted.
  const { promptArgs: _promptArgs, promptFile: _promptFile, name: _name, ...extractionOptions } =
    produceOptions;
  const extraction = await sandcastle.run({
    ...extractionOptions,
    ...(produceOptions.name ? { name: `${produceOptions.name} (extract)` } : {}),
    prompt: extractionPrompt,
    resumeSession: sessionId,
    output: { ...output, maxRetries },
  });

  return { ...produce, output: extraction.output };
}
