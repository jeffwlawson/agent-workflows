import { describe, expect, it } from "vitest";
import { dropBlock, spliceBlock } from "../../engine/splice.js";

const MARKERS = { start: "<!-- s -->", end: "<!-- /s -->" };
const block = `${MARKERS.start}new${MARKERS.end}`;

describe("spliceBlock", () => {
  it("replaces the one block, markers and all, and keeps the text around it", () => {
    expect(spliceBlock(`Before\n${MARKERS.start}old${MARKERS.end}\nAfter`, MARKERS, block, "leave")).toBe(`Before\n${block}\nAfter`);
  });

  it("appends to a body with none where asked, and leaves it where not", () => {
    expect(spliceBlock("Mine.", MARKERS, block, "append")).toBe(`Mine.\n\n${block}`);
    expect(spliceBlock("Mine.\n", MARKERS, block, "append")).toBe(`Mine.\n\n${block}`);
    expect(spliceBlock("", MARKERS, block, "append")).toBe(block);
    expect(spliceBlock("Mine.", MARKERS, block, "leave")).toBe("Mine.");
  });

  it("refuses half a block, or two", () => {
    expect(spliceBlock(`${MARKERS.start}x`, MARKERS, block, "append")).toBeUndefined();
    expect(spliceBlock(`x${MARKERS.end}`, MARKERS, block, "append")).toBeUndefined();
    expect(spliceBlock(`${block}${block}`, MARKERS, block, "append")).toBeUndefined();
    expect(spliceBlock(`${MARKERS.end}x${MARKERS.start}`, MARKERS, block, "append")).toBeUndefined();
  });
});

describe("dropBlock", () => {
  it("removes the one block and up to two line breaks after it", () => {
    expect(dropBlock(`Before\n${block}\r\n\n\nAfter`, MARKERS)).toBe("Before\n\nAfter");
  });

  it("refuses none, half a block, or two", () => {
    expect(dropBlock("Mine.", MARKERS)).toBeUndefined();
    expect(dropBlock(`${MARKERS.start}x`, MARKERS)).toBeUndefined();
    expect(dropBlock(`${block}${block}`, MARKERS)).toBeUndefined();
  });
});
