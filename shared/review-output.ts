import { asArray, asRecord, asString, standardSchema } from "./common.js";

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface ReviewOutput {
  readonly summary: string;
  readonly inlineComments: InlineComment[];
}

const parseInlineComment = (value: unknown): InlineComment => {
  const record = asRecord(value, "inline comment");
  const line = record["line"];
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) {
    throw new Error("inline comment line must be a positive integer");
  }
  return {
    path: asString(record["path"] ?? record["file"], "inline comment path"),
    line,
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
    if (!fileLines.has(comment.line)) {
      console.warn(`Dropping comment for ${comment.path}:${comment.line}; line not in diff hunks.`);
      return false;
    }
    return true;
  });
