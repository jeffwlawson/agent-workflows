/**
 * PROTOTYPE (#399), throwaway. Marker splicing, moved from
 * `shared/progress-list.ts`'s `spliceBlock` and the two `jq` copies in
 * `review.yml`. The markers are the loop's and are handed in: the engine
 * knows no record string.
 */

/**
 * `body` with the text between `start` and `end` replaced by `block`, markers
 * and all. Undefined for half a block, or two. A body with none gets `block`
 * appended where `whenMissing` is `append`, and comes back as it is where it
 * is `leave`.
 */
export const spliceBlock = (
  body: string,
  markers: { readonly start: string; readonly end: string },
  block: string,
  whenMissing: "append" | "leave",
): string | undefined => {
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
 * to two line breaks after it. Undefined where there is not exactly one.
 */
export const dropBlock = (body: string, markers: { readonly start: string; readonly end: string }): string | undefined => {
  const starts = body.split(markers.start);
  const ends = body.split(markers.end);
  const [before = "", after = ""] = starts;
  const inside = after.split(markers.end);
  if (starts.length !== 2 || ends.length !== 2 || inside.length !== 2) return undefined;
  return before + (inside[1] ?? "").replace(/^(\r?\n){1,2}/, "");
};
