/**
 * Marker splicing: the block between two markers in a body the loop does not
 * own, replaced or removed. The markers are the loop's and are handed in: the
 * engine knows no record string. A loop function hands one of these to
 * `editPullRequest` as its `body`, so the splice is made against the live body.
 */

export interface Markers {
  readonly start: string;
  readonly end: string;
}

/**
 * `body` with the text between the markers replaced by `block`, markers and
 * all. Undefined for half a block, or two: which marker is the real one is
 * where a maintainer's text ends, and that is not a guess to make. A body with
 * neither marker gets `block` appended where `whenMissing` is `append`, and
 * comes back as it is where it is `leave`.
 */
export const spliceBlock = (body: string, markers: Markers, block: string, whenMissing: "append" | "leave"): string | undefined => {
  const starts = body.split(markers.start);
  const ends = body.split(markers.end);
  if (starts.length === 1 && ends.length === 1) {
    if (whenMissing === "leave") return body;
    return body === "" ? block : `${body}${body.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  }
  const [before = "", after = ""] = starts;
  const inside = after.split(markers.end);
  if (starts.length === 2 && ends.length === 2 && inside.length === 2) return `${before}${block}${inside[1] ?? ""}`;
  return undefined;
};

/**
 * `body` with the block between the markers removed, markers and all, and up
 * to two line breaks after it. Undefined where there is not exactly one block,
 * by `spliceBlock`'s rule.
 */
export const dropBlock = (body: string, markers: Markers): string | undefined => {
  const starts = body.split(markers.start);
  const ends = body.split(markers.end);
  const [before = "", after = ""] = starts;
  const inside = after.split(markers.end);
  if (starts.length !== 2 || ends.length !== 2 || inside.length !== 2) return undefined;
  return before + (inside[1] ?? "").replace(/^(\r?\n){1,2}/, "");
};
