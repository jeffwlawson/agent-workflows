/**
 * What one agent run spent (#637): tokens by kind, turns, the model and the
 * effort, per pass, with an estimated cost, summed from the session
 * transcript and the stream's result event. The driver (`shared/agent.ts`)
 * reads both and hands them in; nothing here reads a file or the environment.
 *
 * Two sources, because neither has all of it:
 *
 * - **The transcript**, the session's and each of its subagents' at
 *   `<session>/subagents/*.jsonl`, has every assistant message, each with its `usage`:
 *   input, cache read and cache write split by its 5-minute and 1-hour TTL.
 *   Claude Code writes one line per content block, each carrying the
 *   message's usage, so a message is counted once, by its id. Its
 *   `output_tokens` is a placeholder written while the message streams, so it
 *   is never summed.
 * - **The result event**, the stream's last line, has the real output count
 *   (its `modelUsage`, or its `usage` where that is missing) and Claude
 *   Code's own cost estimate.
 *
 * The cost is an estimate, not a bill.
 */

/** A runner's two kinds of pass: the work, and `runWithExtraction`'s format-only one. */
export type Pass = "work" | "extract";

/** What a pass's transcript gives. */
export interface TranscriptTotals {
  /** Assistant messages, each counted once. */
  readonly turns: number;
  /** The models that answered, in order of first answer. */
  readonly models: readonly string[];
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  /** The message ids counted, so a later pass resuming the session counts none of them again. */
  readonly messages: readonly string[];
}

/** What a pass's result events give, where the stream ended on one. */
export interface ResultTotals {
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export type PassUsage =
  | ({ readonly pass: Pass; readonly available: true } & Omit<TranscriptTotals, "messages"> & ResultTotals)
  | { readonly pass: Pass; readonly available: false; readonly reason: string };

/** `usage.json`: every pass so far, and the line the summary shows. */
export interface RunUsage {
  /** The effort the agent was started with, or `default` where none was set. */
  readonly effort: string;
  readonly passes: readonly PassUsage[];
  readonly summary: string;
}

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** Each line of `text` that parses as a JSON object; a torn or foreign line is skipped. */
const objects = (text: string): Json[] =>
  text.split("\n").flatMap((line) => {
    if (!line.trimStart().startsWith("{")) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isObject(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });

/**
 * Sums a session transcript's assistant messages, skipping each id in
 * `counted` (an earlier pass's) and Claude Code's own `<synthetic>` ones,
 * which no model answered. Throws where the transcript holds no assistant
 * message to count: a transcript of nothing is not a run that spent nothing.
 */
export const sumTranscript = (jsonl: string, counted: ReadonlySet<string>): TranscriptTotals => {
  const messages = new Map<string, Json>();
  for (const line of objects(jsonl)) {
    const message = line["message"];
    if (line["type"] !== "assistant" || !isObject(message) || !isObject(message["usage"])) continue;
    const id = typeof message["id"] === "string" ? message["id"] : typeof line["uuid"] === "string" ? line["uuid"] : undefined;
    if (id === undefined || message["model"] === "<synthetic>") continue;
    // The last line of a message carries its final usage.
    messages.set(id, message);
  }
  const fresh = [...messages].filter(([id]) => !counted.has(id));
  if (fresh.length === 0) throw new Error("the transcript holds no assistant message for this pass");

  const models: string[] = [];
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  for (const [, message] of fresh) {
    const usage = message["usage"] as Json;
    const model = message["model"];
    if (typeof model === "string" && !models.includes(model)) models.push(model);
    inputTokens += count(usage["input_tokens"]);
    cacheReadTokens += count(usage["cache_read_input_tokens"]);
    const split = usage["cache_creation"];
    if (isObject(split)) {
      cacheWrite5mTokens += count(split["ephemeral_5m_input_tokens"]);
      cacheWrite1hTokens += count(split["ephemeral_1h_input_tokens"]);
    } else {
      // No split recorded: the 5-minute TTL is the API's default.
      cacheWrite5mTokens += count(usage["cache_creation_input_tokens"]);
    }
  }
  return {
    turns: fresh.length,
    models,
    inputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    messages: fresh.map(([id]) => id),
  };
};

/**
 * Sums the result events among a pass's stream lines: one per agent process
 * the pass started, so more than one where its output was retried. Output is
 * `modelUsage`'s, every model's, or the event's `usage` where it has none;
 * the cost is `total_cost_usd`, or `modelUsage`'s. Either is `null` where no
 * event gave it.
 */
export const sumResults = (lines: readonly string[]): ResultTotals => {
  let outputTokens: number | null = null;
  let costUsd: number | null = null;
  const add = (total: number | null, value: number | undefined): number | null =>
    value === undefined ? total : (total ?? 0) + value;
  for (const event of lines.flatMap(objects)) {
    if (event["type"] !== "result") continue;
    const models = isObject(event["modelUsage"]) ? Object.values(event["modelUsage"]).filter(isObject) : [];
    const usage = isObject(event["usage"]) ? event["usage"] : undefined;
    const output =
      models.length > 0
        ? models.reduce((sum, m) => sum + count(m["outputTokens"]), 0)
        : usage !== undefined && typeof usage["output_tokens"] === "number"
          ? count(usage["output_tokens"])
          : undefined;
    const cost =
      typeof event["total_cost_usd"] === "number"
        ? count(event["total_cost_usd"])
        : models.length > 0
          ? models.reduce((sum, m) => sum + count(m["costUSD"]), 0)
          : undefined;
    outputTokens = add(outputTokens, output);
    costUsd = add(costUsd, cost);
  }
  return { outputTokens, costUsd };
};

const tokens = (n: number): string => n.toLocaleString("en-US");

const passLine = (usage: PassUsage): string => {
  if (!usage.available) return `${usage.pass}: usage unavailable (${usage.reason})`;
  const on = usage.models.length === 0 ? "" : ` on ${usage.models.join(", ")}`;
  const output = usage.outputTokens === null ? "output unavailable" : `output ${tokens(usage.outputTokens)}`;
  const cost = usage.costUsd === null ? "cost unavailable" : `about $${usage.costUsd.toFixed(2)}`;
  return (
    `${usage.pass}: ${usage.turns} turn${usage.turns === 1 ? "" : "s"}${on}, input ${tokens(usage.inputTokens)}, ` +
    `cache read ${tokens(usage.cacheReadTokens)}, cache write ${tokens(usage.cacheWrite5mTokens)} (5m) and ` +
    `${tokens(usage.cacheWrite1hTokens)} (1h), ${output}, ${cost}`
  );
};

/** The one line a run's usage is shown as, in its log and its summary. */
export const usageSummary = (effort: string, passes: readonly PassUsage[]): string => {
  if (passes.length === 0) return "Agent usage unavailable: no agent pass ran.";
  if (passes.every((p) => !p.available)) return `Agent usage unavailable: ${passes.map(passLine).join("; ")}.`;
  return `Agent usage (effort ${effort}): ${passes.map(passLine).join("; ")}.`;
};
