import { asArray, asRecord, asString } from "./common.js";
import { VERDICTS } from "./review-output.js";

/**
 * The **slices table** in a PRD PR's body (#164, #174): one row per slice, in
 * merge order, written by the run that merges that slice and never refreshed.
 * It is how a maintainer sees every slice, its verdict and its open findings in
 * one place — and, on the draft PRD PR, how far the chain has got.
 *
 * Pure, and the only seam in it. Nothing here reads a GitHub surface: the merge
 * step gathers the facts through `gh` into a file, and `implement-prd` reads the
 * body, calls this and writes the answer back. So everything worth arguing
 * about — what a row says, and what a splice may touch — is decided from plain
 * values, and tested from them.
 *
 * The table is a **pointer, not a gate**. A 🟡 row's findings are linked where
 * the slice round left them and never re-raised: the PRD PR's own review is an
 * integration review, and its automatic fix is not to be spent on findings a
 * slice round already ended on.
 */

export const SLICES_START = "<!-- agent:slices -->";
export const SLICES_END = "<!-- /agent:slices -->";
export const SLICES_HEADING = "## Slices";

/** Links shown per row before the rest collapse into `+N more`, so no row grows wide. */
export const MAX_FINDING_LINKS = 3;

const HEADER = ["| Slice | PR | Verdict | Open findings |", "|---|---|---|---|"];

/** An unresolved review thread on a slice PR. `line` is null for a file-level thread. */
export interface OpenThread {
  readonly path: string;
  readonly line: number | null;
  readonly url: string;
}

/** A slice whose slice PR the run has just merged into the PRD branch. */
export interface MergedSlice {
  /** The sub-issue's title. */
  readonly title: string;
  readonly subIssue: number;
  readonly slicePr: number;
  /** The slice PR's conversation, which `+N more` links to. */
  readonly slicePrUrl: string;
  /**
   * The description of the `agent-review` status on the slice PR's **merged
   * head**, or null if it carries none — the verdict of the code that landed.
   */
  readonly verdict: string | null;
  readonly openThreads: readonly OpenThread[];
}

/** A sub-issue a pre-upgrade chain built straight onto the PRD branch, with no slice PR. */
export interface PreUpgradeSlice {
  readonly title: string;
  readonly subIssue: number;
}

/** What one merge adds to the table. */
export interface SlicesUpdate {
  /**
   * Slices merged by an earlier run that died before writing their rows (#207),
   * in merge order. Written before `merged`, which merged after them.
   */
  readonly backfill: readonly MergedSlice[];
  readonly merged: MergedSlice;
  /** Closed sub-issues with no slice PR, in sub-issue order. Written only when the table is created. */
  readonly preUpgrade: readonly PreUpgradeSlice[];
}

/** One line, and no character that ends a table cell. */
const cell = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").replace(/\|/g, "\\|");

/** Link text: a cell, and no bracket that ends the link early. */
const linkText = (text: string): string => cell(text).replace(/[[\]]/g, "\\$&");

const sliceCell = (title: string, subIssue: number): string => `${cell(title)} (#${subIssue})`;

/**
 * The verdict's marker, from the status description the review posted. Read by
 * the label every description starts with, because the marker itself is what a
 * status refuses to carry (`VerdictRow.label`).
 *
 * 🔵 is a slice nobody's round ended well on: the chain parks there, and the only
 * way past it is a human re-adding `agent:implement`. So on a row that merged,
 * it can only mean accepted by hand, and the row says so — it is the one row a
 * maintainer did not watch happen.
 */
const verdictCell = (verdict: string | null): string => {
  const row =
    verdict === null
      ? undefined
      : Object.values(VERDICTS).find((candidate) => verdict.startsWith(`${candidate.label}.`));
  if (row === undefined) return "no verdict";

  const marker = row.heading.split(" ")[0] ?? "";
  return row.verdict === "needs a closer look" ? `${marker} accepted by hand` : marker;
};

/** File name and line, never the path: a path is what makes a row wide. */
const threadLink = (thread: OpenThread): string => {
  const name = thread.path.split("/").at(-1) ?? thread.path;
  const text = thread.line === null ? name : `${name}:${thread.line}`;
  return `[${linkText(text)}](${thread.url})`;
};

const findingsCell = (threads: readonly OpenThread[], slicePrUrl: string): string => {
  if (threads.length === 0) return "none";

  const links = threads.slice(0, MAX_FINDING_LINKS).map(threadLink);
  const rest = threads.length - MAX_FINDING_LINKS;
  if (rest > 0) links.push(`[+${rest} more](${slicePrUrl})`);
  return links.join(", ");
};

const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

/** The row of a slice whose slice PR has just merged. */
export const renderSliceRow = (slice: MergedSlice): string =>
  row([
    sliceCell(slice.title, slice.subIssue),
    `#${slice.slicePr}`,
    verdictCell(slice.verdict),
    findingsCell(slice.openThreads, slice.slicePrUrl),
  ]);

/** The row of a slice built before slice PRs existed: no PR, and no review of its own. */
export const renderPreUpgradeRow = (slice: PreUpgradeSlice): string =>
  row([sliceCell(slice.title, slice.subIssue), "n/a", "built before slice PRs, no review of its own", "n/a"]);

/**
 * The sub-issue a row is for, read from the end of its first cell — the key that
 * makes a splice idempotent per row. Cells are split on unescaped pipes only,
 * which is what `cell` escapes a title's own to.
 */
const rowKey = (line: string): number | undefined => {
  const first = line.split(/(?<!\\)\|/)[1];
  const match = first === undefined ? null : /\(#(\d+)\)\s*$/.exec(first);
  return match === null ? undefined : Number(match[1]);
};

const isHeader = (line: string): boolean => HEADER.includes(line.trim());

const block = (rows: readonly string[]): string => [SLICES_START, ...HEADER, ...rows, SLICES_END].join("\n");

/** Where the block sits in `body`, or undefined if it has none. */
const locate = (body: string): { readonly start: number; readonly end: number } | undefined => {
  const start = body.indexOf(SLICES_START);
  const end = body.indexOf(SLICES_END, start < 0 ? 0 : start + SLICES_START.length);

  if (start < 0 && body.indexOf(SLICES_END) < 0) return undefined;
  // Half a block is refused rather than repaired. Appending a second one would
  // find the stray marker again on every later run and append again, and
  // guessing which half is the real one is guessing where a human's text ends.
  if (start < 0 || end < 0) {
    throw new Error(
      `The PRD PR body has a broken slices table: it carries one of \`${SLICES_START}\` and \`${SLICES_END}\` ` +
        `without the other after it. Restore the missing marker, or delete both and the rows between them, ` +
        `and the next run writes the table again.`,
    );
  }
  return { start, end: end + SLICES_END.length };
};

/** Whether `body` already carries a slices table. */
export const hasSlicesTable = (body: string): boolean => locate(body) !== undefined;

/**
 * Add `rows` to the slices table in `body`, in order, after the rows already
 * there.
 *
 * - **Idempotent per row.** A row for a sub-issue the table already has is not
 *   added again — nor rewritten: rows are never refreshed, so a retried run that
 *   gathered its facts a second time leaves the first row standing.
 * - **Nothing outside the markers is touched**, byte for byte. A maintainer's
 *   own edits to the PRD PR body survive every run.
 * - **A body with no block gets one**, appended under `## Slices`: a PRD PR that
 *   predates the table is written into, not refused.
 */
export const spliceSliceRows = (body: string, rows: readonly string[]): string => {
  const found = locate(body);

  if (found === undefined) {
    const fresh = dedupe([], rows);
    const separator = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return `${body}${separator}${SLICES_HEADING}\n${block(fresh)}\n`;
  }

  const inner = body.slice(found.start + SLICES_START.length, found.end - SLICES_END.length);
  const existing = inner
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !isHeader(line));

  return `${body.slice(0, found.start)}${block(dedupe(existing, rows))}${body.slice(found.end)}`;
};

/** `existing`, then every row of `rows` whose sub-issue none before it has. */
const dedupe = (existing: readonly string[], rows: readonly string[]): string[] => {
  const kept = [...existing];
  const seen = new Set(existing.map(rowKey).filter((key) => key !== undefined));
  for (const line of rows) {
    const key = rowKey(line);
    if (key !== undefined && seen.has(key)) continue;
    if (key !== undefined) seen.add(key);
    kept.push(line);
  }
  return kept;
};

/**
 * One merge's worth of table: the merged slice's row, preceded by the rows of
 * any slices an earlier run merged and died before writing, and (**the first
 * time the table is written**, and only then) by a row for each slice a
 * pre-upgrade chain built. Each group was merged before the next, so merge
 * order is the order they are listed in; and once the table exists, a sub-issue
 * closed with no slice PR is not one the chain built before the upgrade.
 */
export const addMergedSlice = (body: string, update: SlicesUpdate): string =>
  spliceSliceRows(body, [
    ...(hasSlicesTable(body) ? [] : update.preUpgrade.map(renderPreUpgradeRow)),
    ...update.backfill.map(renderSliceRow),
    renderSliceRow(update.merged),
  ]);

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
};

/**
 * The facts file the merge step writes, read back. It is this workflow's own
 * output, so a shape that does not match is a defect here rather than input to
 * tolerate — and a row written from half of it would stand forever.
 */
export const parseSlicesUpdate = (raw: unknown): SlicesUpdate => {
  const record = asRecord(raw, "slices table facts");

  return {
    backfill: asArray(record["backfill"], "backfill").map((slice, i) => parseMergedSlice(slice, `backfill[${i}]`)),
    merged: parseMergedSlice(record["merged"], "merged"),
    preUpgrade: asArray(record["preUpgrade"], "preUpgrade").map((raw, i) => {
      const slice = asRecord(raw, `preUpgrade[${i}]`);
      return {
        title: asString(slice["title"], `preUpgrade[${i}].title`),
        subIssue: asNumber(slice["subIssue"], `preUpgrade[${i}].subIssue`),
      };
    }),
  };
};

const parseMergedSlice = (raw: unknown, label: string): MergedSlice => {
  const merged = asRecord(raw, label);
  const verdict = merged["verdict"];

  return {
    title: asString(merged["title"], `${label}.title`),
    subIssue: asNumber(merged["subIssue"], `${label}.subIssue`),
    slicePr: asNumber(merged["slicePr"], `${label}.slicePr`),
    slicePrUrl: asString(merged["slicePrUrl"], `${label}.slicePrUrl`),
    verdict: verdict === null || verdict === undefined ? null : asString(verdict, `${label}.verdict`),
    openThreads: asArray(merged["openThreads"], `${label}.openThreads`).map((raw, i) => {
      const thread = asRecord(raw, `${label}.openThreads[${i}]`);
      const line = thread["line"];
      return {
        path: asString(thread["path"], `${label}.openThreads[${i}].path`),
        line: line === null || line === undefined ? null : asNumber(line, `${label}.openThreads[${i}].line`),
        url: asString(thread["url"], `${label}.openThreads[${i}].url`),
      };
    }),
  };
};
