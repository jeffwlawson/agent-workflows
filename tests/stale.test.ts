import { describe, expect, it } from "vitest";
import { staleFailure, staleReason } from "../shared/stale.js";

describe("staleReason", () => {
  it("finds the reason inside the tag, trimmed", () => {
    expect(staleReason("Checked the issue.\n<stale>\n  The step it removes is already gone.\n</stale>\n")).toBe(
      "The step it removes is already gone.",
    );
  });

  it("gives nothing where the output has no tag", () => {
    expect(staleReason("Done.\n<promise>COMPLETE</promise>")).toBeUndefined();
  });

  it("gives nothing for an empty tag", () => {
    expect(staleReason("<stale>   \n</stale>")).toBeUndefined();
  });

  it("takes the last tag where there are several", () => {
    expect(staleReason("I will end with <stale>…</stale>.\n<stale>The function was replaced.</stale>")).toBe(
      "The function was replaced.",
    );
  });
});

describe("staleFailure", () => {
  it("frames the reason as the issue no longer matching the code", () => {
    expect(staleFailure("issue #7", "It is gone.")).toBe(
      "The agent stopped because issue #7 no longer matches the code: It is gone.",
    );
  });
});
