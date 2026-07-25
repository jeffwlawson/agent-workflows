import { asArray, asRecord, asString, standardSchema } from "./common.js";

export interface InlineComment {
  readonly path: string;
  /** Last line of the range — the only line when `startLine` is absent. */
  readonly line: number;
  /**
   * First line of a multi-line range. Needed when a ```suggestion block
   * replaces more than one line: GitHub applies the suggestion to exactly
   * `startLine..line`, so a stale sentence spanning two lines cannot be fixed
   * from a single-line anchor.
   */
  readonly startLine?: number;
  readonly body: string;
}

export interface ReviewOutput {
  readonly summary: string;
  readonly inlineComments: InlineComment[];
}

const positiveInt = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};

const parseInlineComment = (value: unknown): InlineComment => {
  const record = asRecord(value, "inline comment");
  const line = positiveInt(record["line"], "inline comment line");

  const rawStart = record["startLine"] ?? record["start_line"];
  let startLine: number | undefined;
  if (rawStart !== undefined && rawStart !== null) {
    startLine = positiveInt(rawStart, "inline comment startLine");
    if (startLine > line) {
      throw new Error("inline comment startLine must be <= line");
    }
    // A one-line "range" is just a single-line comment; GitHub rejects
    // start_line == line, so normalise it away rather than fail the review.
    if (startLine === line) startLine = undefined;
  }

  return {
    path: asString(record["path"] ?? record["file"], "inline comment path"),
    line,
    ...(startLine === undefined ? {} : { startLine }),
    body: asString(record["body"] ?? record["comment"], "inline comment body"),
  };
};

export const reviewOutputSchema = standardSchema<ReviewOutput>((value) => {
  const record = asRecord(value, "review output");
  return {
    summary: asString(record["summary"], "summary"),
    inlineComments: asArray(record["inlineComments"] ?? [], "inlineComments").map(
      parseInlineComment,
    ),
  };
});

/**
 * Drop any inline comment whose (path, line) is not in the diff. The model
 * routinely invents plausible line numbers, and GitHub rejects the *entire*
 * review if even one comment is off-diff — so this filter is what stands
 * between a useful review and a 422 that posts nothing.
 */
export const filterInlineComments = (
  comments: readonly InlineComment[],
  diffLines: Map<string, Set<number>>,
): InlineComment[] =>
  comments.filter((comment) => {
    const fileLines = diffLines.get(comment.path);
    if (!fileLines) {
      console.warn(`Dropping comment for ${comment.path}:${comment.line}; file not in diff.`);
      return false;
    }
    // Every line of a multi-line anchor must be in the diff, not just the end
    // of the range — GitHub rejects the whole review otherwise.
    const from = comment.startLine ?? comment.line;
    for (let line = from; line <= comment.line; line++) {
      if (!fileLines.has(line)) {
        console.warn(
          `Dropping comment for ${comment.path}:${from}-${comment.line}; line ${line} not in diff hunks.`,
        );
        return false;
      }
    }
    return true;
  });
