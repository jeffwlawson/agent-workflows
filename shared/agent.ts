import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { AgentProvider, OutputObjectDefinition, RunOptions, RunResult } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { bwrap, CARRY_HOOKS } from "../engine/bwrap.js";
import type { SANDBOX } from "./contract.js";
import { fail, type InputValues } from "./env.js";
import { sandboxRefusal } from "./sandbox.js";
import { sumResults, sumTranscript, usageSummary, type Pass, type PassUsage, type RunUsage } from "./usage.js";

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

/**
 * The sandbox inputs every runner declares (`SANDBOX` in `shared/contract.ts`),
 * as `readInputs` read them: `AGENT_SANDBOX` is already one of the values it
 * accepts, since any other fails the run there, naming it.
 */
export type SandboxInputs = InputValues<typeof SANDBOX>;

/**
 * The sandbox every runner starts the agent in, chosen here and nowhere else,
 * as the run options that select it: a runner names no provider, and this is
 * the one module that loads Sandcastle, so no command can reach the choice.
 *
 * - `none`: the agent runs on the runner's own machine. On Actions the
 *   ephemeral runner IS the isolation, and running the agent directly on it
 *   means the agent's environment and CI's are identical by construction: no
 *   image drift, no "works in the sandbox, fails in CI".
 * - `bwrap`: the agent runs in bubblewrap on the host (`engine/bwrap.ts`),
 *   with the toolchain, `PATH` and proxy its inputs name, and a network of
 *   its own whose only way out is that proxy. Without a proxy it is refused,
 *   through `fail()`, naming `AGENT_SANDBOX_PROXY` (`shared/sandbox.ts`), so
 *   call it at start, before any of the runner's own work. The run starts in
 *   the checkout, which is where Sandcastle writes its patches. Its hooks
 *   carry what the checkout holds outside git, the setup's install, into the
 *   agent's copy of it, so the agent sees what it would with no sandbox.
 *
 * Spread it into the run's options, once per runner, and hand both of
 * `runWithExtraction`'s passes the one provider: `bwrap` carries the session
 * between them itself.
 */
export const agentSandbox = (inputs: SandboxInputs) => {
  const refusal = sandboxRefusal(inputs.AGENT_SANDBOX, inputs.AGENT_SANDBOX_PROXY);
  if (refusal !== undefined) return fail(refusal);
  switch (inputs.AGENT_SANDBOX) {
    case "none":
      return { sandbox: noSandbox() };
    case "bwrap":
      return {
        sandbox: bwrap({
          roBinds: inputs.AGENT_SANDBOX_RO_BINDS.split(":").filter((dir) => dir !== ""),
          path: inputs.AGENT_SANDBOX_PATH,
          proxy: inputs.AGENT_SANDBOX_PROXY,
          repoDir: process.cwd(),
          homeDir: homedir(),
        }),
        hooks: CARRY_HOOKS,
      };
  }
};

/** What `agentSandbox` selects: the run options a runner spreads. */
export type AgentSandbox = ReturnType<typeof agentSandbox>;

/**
 * A run whose agent concludes the merge in progress in the checkout: the run
 * options to spread in place of the sandbox's, into every pass, and
 * `conclude`, to call once the last pass has ended.
 */
export interface ConcludingMerge {
  readonly options: Pick<RunOptions, "sandbox" | "hooks" | "branchStrategy">;
  /**
   * Leaves the checkout as the agent leaves it with no sandbox: on a merge
   * of the base into the head, committed, holding the agent's resolution.
   * Throws a sentence where the agent's work did not come back as one.
   */
  conclude(): void;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * The sandbox for a run whose agent resolves the conflicts of the merge in
 * progress in the checkout at `repoDir` and commits it (#463's run).
 *
 * With no sandbox the agent works in the checkout, mid-merge, and its commit
 * is the merge: the options are the sandbox's, and `conclude` does nothing.
 *
 * An isolated sandbox cannot carry that merge either way. Sandcastle clones
 * the agent's copy from the checkout's history, so the copy starts on the
 * head, clean: `MERGE_HEAD` and the conflicted index are not history. It
 * hands the agent's commits back as `git format-patch` output, which leaves a
 * merge commit out. And under its default strategy it ends with a `git merge`
 * of its temporary branch in the checkout, which git refuses mid-merge. So:
 *
 * - The agent works on a branch of its own, made at the head, and Sandcastle
 *   leaves its commits there rather than merging them into the checkout.
 * - The copy is put mid-merge as a squash, by the hook that carries the
 *   checkout's untracked paths, after them, in one command, since Sandcastle
 *   starts a run's hooks together: the same conflicts, staged as git leaves
 *   them, with no `MERGE_HEAD`, so the agent's commit is an ordinary one the
 *   patches carry whole. Only a copy at the head is: the extraction pass's,
 *   at the agent's commit, is left as it is.
 * - `conclude` makes the merge in the checkout, from the head and the base
 *   commit being merged, with the tree of the agent's last commit, git's
 *   subject for the merge and the agent's message body, and moves the
 *   checkout's branch onto it. A branch still checked out in a worktree of
 *   Sandcastle's is a copy-out that did not finish, and is refused.
 */
export const concludingMerge = (chosen: AgentSandbox, repoDir: string, name: string): ConcludingMerge => {
  // The isolated choice is the one with the carry hooks: `bwrap`'s.
  if (!("hooks" in chosen)) return { options: chosen, conclude: () => {} };
  const git = (args: readonly string[], input?: string): string =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", ...(input === undefined ? {} : { input }) }).trim();
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  const base = git(["rev-parse", "--verify", "MERGE_HEAD^{commit}"]);
  if (!SHA.test(head) || !SHA.test(base)) throw new Error(`Couldn't read the merge in progress: \`${head}\` into \`${base}\`.`);
  const mergeMessage = path.resolve(repoDir, git(["rev-parse", "--git-path", "MERGE_MSG"]));
  const subject = existsSync(mergeMessage) ? (readFileSync(mergeMessage, "utf8").split("\n")[0] ?? "").trim() : "";
  const branch = `sandcastle/${name}/merge`;
  git(["branch", "--force", branch, head]);

  const [carry] = chosen.hooks.sandbox.onSandboxReady;
  const squash = `if [ "$(git rev-parse HEAD)" = ${head} ]; then git merge --squash ${base} >/dev/null || [ -n "$(git ls-files --unmerged)" ]; fi`;
  const options = {
    sandbox: chosen.sandbox,
    hooks: { sandbox: { onSandboxReady: [{ command: `${carry.command} && ${squash}`, timeoutMs: carry.timeoutMs }] } },
    branchStrategy: { type: "branch", branch },
  } as const;

  const conclude = (): void => {
    const held = git(["worktree", "list", "--porcelain"])
      .split("\n\n")
      .find((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`));
    if (held !== undefined) {
      const at = held.split("\n")[0]?.replace(/^worktree /, "") ?? "";
      throw new Error(`The agent's work didn't come out of its sandbox whole (its copy is kept at \`${at}\`), so nothing was pushed.`);
    }
    const tip = git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    if (tip === head) throw new Error("The agent finished without committing its resolution, so nothing was pushed.");
    const [own = "", ...body] = git(["log", "-1", "--format=%B", tip]).split("\n");
    const message = [subject === "" ? own : subject, ...body].join("\n").trim();
    const merge = git(["commit-tree", `${tip}^{tree}`, "-p", head, "-p", base, "-F", "-"], `${message}\n`);
    git(["reset", "--quiet", "--hard", merge]);
    git(["branch", "--delete", "--force", branch]);
  };
  return { options, conclude };
};

/**
 * A run's usage ledger (#637): each pass of the agent is started through
 * `pass`, which reads what it spent once it ends, however it ends, and hands
 * the run's usage so far, every pass's, to `write`, which a runner points at
 * its `usage.json`. A pass whose usage cannot be read is recorded as
 * unavailable, with the reason; nothing here throws into the run.
 */
export interface UsageLedger {
  /**
   * Starts one pass with `agent`, through `start`, and records it. `start`
   * runs Sandcastle with the agent it is handed, which is `agent` with the
   * stream's session ids and result events kept for the ledger.
   */
  pass<R>(pass: Pass, agent: AgentProvider, start: (agent: AgentProvider) => Promise<R>): Promise<R>;
}

/** The effort an agent is started with, read off the command it runs: `default` where it names none. */
const effortOf = (agent: AgentProvider): string => {
  try {
    return /\s--effort\s+(\S+)/.exec(agent.buildPrintCommand({ prompt: "", dangerouslySkipPermissions: true }).command)?.[1] ?? "default";
  } catch {
    return "default";
  }
};

/**
 * The transcripts of a session's subagents, beside its own at
 * `<session>/subagents/*.jsonl`: their turns are the pass's too, and the
 * result event's output and cost already count them.
 */
const subagentTranscripts = (session: string): string[] => {
  const dir = path.join(path.dirname(session), path.basename(session, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(dir, name));
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const usageLedger = (write: (usage: RunUsage) => void): UsageLedger => {
  const passes: PassUsage[] = [];
  const counted = new Set<string>();
  /** Sessions a pass could not be read from: a later pass resuming one cannot be told apart from it. */
  const unread = new Set<string>();
  let effort = "default";

  const measure = async (pass: Pass, sessions: readonly string[], results: readonly string[]): Promise<PassUsage> => {
    if (sessions.length === 0) return { pass, available: false, reason: "the agent's stream named no session" };
    const earlier = sessions.find((id) => unread.has(id));
    if (earlier !== undefined) return { pass, available: false, reason: `an earlier pass in session ${earlier} could not be read` };
    let transcript = "";
    for (const id of sessions) {
      const found = (await sandcastle.findClaudeSessionOnHost(id)).path;
      if (found === undefined) return { pass, available: false, reason: `no transcript of session ${id} was found` };
      transcript += `${readFileSync(found, "utf8")}\n`;
      for (const file of subagentTranscripts(found)) transcript += `${readFileSync(file, "utf8")}\n`;
    }
    const { messages, ...totals } = sumTranscript(transcript, counted);
    for (const id of messages) counted.add(id);
    return { pass, available: true, ...totals, ...sumResults(results) };
  };

  return {
    async pass(pass, agent, start) {
      const sessions: string[] = [];
      const results: string[] = [];
      effort = effortOf(agent);
      const watched: AgentProvider = {
        ...agent,
        parseStreamLine: (line) => {
          const parsed = agent.parseStreamLine(line);
          for (const event of parsed) {
            if (event.type === "session_id" && !sessions.includes(event.sessionId)) sessions.push(event.sessionId);
          }
          if (line.includes('"type":"result"')) results.push(line);
          return parsed;
        },
      };
      try {
        return await start(watched);
      } finally {
        let usage: PassUsage;
        try {
          usage = await measure(pass, sessions, results);
        } catch (error) {
          usage = { pass, available: false, reason: reasonOf(error) };
        }
        if (!usage.available) for (const id of sessions) unread.add(id);
        passes.push(usage);
        const summary = usageSummary(effort, passes);
        console.log(summary);
        try {
          write({ effort, passes, summary });
        } catch (error) {
          console.log(`::warning::The agent's usage was not written: ${reasonOf(error)}`);
        }
      }
    },
  };
};

export interface RunWithExtractionOptions<T> extends Omit<RunOptions, "output"> {
  readonly output: OutputObjectDefinition<T>;
  /** The run's ledger, which records both passes. */
  readonly usage: UsageLedger;
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
  const { output, extractionPrompt, maxRetries = 2, usage, ...produceOptions } = options;
  const produce = await usage.pass("work", produceOptions.agent, (agent) => sandcastle.run({ ...produceOptions, agent }));
  const sessionId = produce.iterations.at(-1)?.sessionId;

  if (!sessionId) {
    throw new Error("Cannot extract structured output: the produce run had no session id.");
  }

  // Drop `promptArgs`, `promptFile` and `name` from the spread rather than
  // reassigning them to `undefined` — `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, so they must be omitted.
  const { promptArgs: _promptArgs, promptFile: _promptFile, name: _name, ...extractionOptions } =
    produceOptions;
  const extraction = await usage.pass("extract", extractionOptions.agent, (agent) =>
    sandcastle.run({
      ...extractionOptions,
      agent,
      ...(produceOptions.name ? { name: `${produceOptions.name} (extract)` } : {}),
      prompt: extractionPrompt,
      resumeSession: sessionId,
      output: { ...output, maxRetries },
    }),
  );

  return { ...produce, output: extraction.output };
}
