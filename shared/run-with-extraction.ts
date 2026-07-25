import {
  run,
  type OutputObjectDefinition,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";

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
  const produce = await run(produceOptions);
  const sessionId = produce.iterations.at(-1)?.sessionId;

  if (!sessionId) {
    throw new Error("Cannot extract structured output: the produce run had no session id.");
  }

  // Drop `promptArgs`, `promptFile` and `name` from the spread rather than
  // reassigning them to `undefined` — `exactOptionalPropertyTypes` forbids
  // assigning `undefined` to an optional property, so they must be omitted.
  const { promptArgs: _promptArgs, promptFile: _promptFile, name: _name, ...extractionOptions } =
    produceOptions;
  const extraction = await run({
    ...extractionOptions,
    ...(produceOptions.name ? { name: `${produceOptions.name} (extract)` } : {}),
    prompt: extractionPrompt,
    resumeSession: sessionId,
    output: { ...output, maxRetries },
  });

  return { ...produce, output: extraction.output };
}
