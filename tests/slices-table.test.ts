import { describe, expect, it } from "vitest";
import { VERDICTS } from "../shared/review-output.js";
import {
  addMergedSlice,
  parseSlicesUpdate,
  renderPreUpgradeRow,
  renderSliceRow,
  SLICES_END,
  SLICES_START,
  spliceSliceRows,
  type MergedSlice,
  type OpenThread,
} from "../shared/slices-table.js";

/**
 * The slices table (#164, #174), from plain values. The halves either side are
 * the merge step's `gh` reads and one body read and write; what a row says, and
 * what a splice may touch, is decided here.
 */

const PR_URL = "https://github.com/o/r/pull/211";

const thread = (path: string, line: number | null, n: number): OpenThread => ({
  path,
  line,
  url: `${PR_URL}#discussion_r${n}`,
});

const slice = (over: Partial<MergedSlice> = {}): MergedSlice => ({
  title: "Wire the advance job",
  subIssue: 202,
  slicePr: 211,
  slicePrUrl: PR_URL,
  verdict: VERDICTS["approval recommended"].description,
  openThreads: [],
  ...over,
});

/** The cells of a rendered row, split on unescaped pipes. */
const cells = (row: string): string[] =>
  row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());

describe("renderSliceRow", () => {
  it("names the slice by its sub-issue, and the slice PR by number", () => {
    const [slicePart, pr] = cells(renderSliceRow(slice()));

    expect(slicePart).toBe("Wire the advance job (#202)");
    expect(pr).toBe("#211");
  });

  it("says none when no thread is left open", () => {
    expect(cells(renderSliceRow(slice()))[3]).toBe("none");
  });

  it("links an open thread by file name and line, never its path", () => {
    const row = renderSliceRow(slice({ openThreads: [thread(".github/workflows/review.yml", 88, 1)] }));

    expect(cells(row)[3]).toBe(`[review.yml:88](${PR_URL}#discussion_r1)`);
  });

  it("links a file-level thread by file name alone", () => {
    expect(cells(renderSliceRow(slice({ openThreads: [thread("docs/a.md", null, 1)] })))[3]).toBe(
      `[a.md](${PR_URL}#discussion_r1)`,
    );
  });

  it("links three threads at most, then +N more to the slice PR's conversation", () => {
    const openThreads = [
      thread(".github/workflows/review.yml", 88, 1),
      thread(".github/workflows/fix.yml", 40, 2),
      thread(".github/workflows/implement.yml", 12, 3),
      ...Array.from({ length: 7 }, (_, i) => thread("x.ts", i + 1, 10 + i)),
    ];

    expect(cells(renderSliceRow(slice({ openThreads })))[3]).toBe(
      [
        `[review.yml:88](${PR_URL}#discussion_r1)`,
        `[fix.yml:40](${PR_URL}#discussion_r2)`,
        `[implement.yml:12](${PR_URL}#discussion_r3)`,
        `[+7 more](${PR_URL})`,
      ].join(", "),
    );
  });

  it("has no +N more at exactly three", () => {
    const openThreads = [thread("a.ts", 1, 1), thread("b.ts", 2, 2), thread("c.ts", 3, 3)];

    expect(cells(renderSliceRow(slice({ openThreads })))[3]).not.toContain("more");
  });

  it.each([
    ["approval recommended", "🟢"],
    ["changes recommended", "🟡"],
    ["changes recommended, fix round started", "🟡"],
    ["changes recommended after a fix round", "🟡"],
    ["needs a closer look", "🔵 accepted by hand"],
  ] as const)("reads %s off the merged head as %s", (verdict, shown) => {
    expect(cells(renderSliceRow(slice({ verdict: VERDICTS[verdict].description })))[2]).toBe(shown);
  });

  it("says so when the merged head carries no verdict", () => {
    expect(cells(renderSliceRow(slice({ verdict: null })))[2]).toBe("no verdict");
    expect(cells(renderSliceRow(slice({ verdict: "Something else entirely." })))[2]).toBe("no verdict");
  });

  it("keeps a title's pipes and newlines from breaking the table", () => {
    const row = renderSliceRow(slice({ title: "a | b\nc" }));

    expect(cells(row)).toHaveLength(4);
    expect(cells(row)[0]).toBe("a \\| b c (#202)");
  });
});

describe("renderPreUpgradeRow", () => {
  it("says the slice was built before slice PRs and had no review of its own", () => {
    const [slicePart, pr, verdict, findings] = cells(renderPreUpgradeRow({ title: "Add the verdict table", subIssue: 201 }));

    expect(slicePart).toBe("Add the verdict table (#201)");
    expect(pr).toBe("n/a");
    expect(verdict).toBe("built before slice PRs, no review of its own");
    expect(findings).toBe("n/a");
  });
});

describe("spliceSliceRows", () => {
  const first = renderSliceRow(slice({ title: "Add the verdict table", subIssue: 201, slicePr: 210 }));
  const second = renderSliceRow(slice());

  it("creates the block under ## Slices in a body that predates it, leaving the body before it as it was", () => {
    const body = "Closes #171\n\nThe PRD branch, built one slice PR at a time.\n";
    const out = spliceSliceRows(body, [first]);

    expect(out.startsWith(body)).toBe(true);
    expect(out.slice(body.length)).toBe(
      ["", "## Slices", SLICES_START, "| Slice | PR | Verdict | Open findings |", "|---|---|---|---|", first, SLICES_END, ""].join(
        "\n",
      ),
    );
  });

  it("separates the block from a body with no trailing newline, and writes an empty one outright", () => {
    expect(spliceSliceRows("Closes #171", [first])).toMatch(/^Closes #171\n\n## Slices\n/);
    expect(spliceSliceRows("", [first])).toMatch(/^## Slices\n/);
  });

  it("appends a row after the ones already there, in merge order", () => {
    const out = spliceSliceRows(spliceSliceRows("Closes #171\n", [first]), [second]);

    expect(out.indexOf(first)).toBeGreaterThan(0);
    expect(out.indexOf(second)).toBeGreaterThan(out.indexOf(first));
  });

  it("is idempotent per row, and never refreshes one", () => {
    const once = spliceSliceRows("Closes #171\n", [first, second]);

    expect(spliceSliceRows(once, [second])).toBe(once);
    // The same sub-issue, gathered again with different facts, is not rewritten.
    expect(spliceSliceRows(once, [renderSliceRow(slice({ verdict: null }))])).toBe(once);
  });

  it("leaves a human's text outside the markers byte for byte", () => {
    const before = "Closes #171\r\n\r\nA maintainer's note — with *emphasis*  \n\n";
    const after = "\n\n### Rollout\n\nTrailing text, no newline";
    const body = `${before}## Slices\n${SLICES_START}\n| Slice | PR | Verdict | Open findings |\n|---|---|---|---|\n${first}\n${SLICES_END}${after}`;
    const out = spliceSliceRows(body, [second]);

    expect(out.startsWith(`${before}## Slices\n${SLICES_START}`)).toBe(true);
    expect(out.endsWith(`${SLICES_END}${after}`)).toBe(true);
    expect(out).toContain(`${first}\n${second}\n${SLICES_END}`);
  });

  it("refuses half a block rather than appending a second one", () => {
    expect(() => spliceSliceRows(`Closes #171\n${SLICES_START}\n| a |\n`, [first])).toThrow(/broken slices table/);
    expect(() => spliceSliceRows(`${SLICES_END}\n${SLICES_START}\n`, [first])).toThrow(/broken slices table/);
  });
});

describe("addMergedSlice", () => {
  const preUpgrade = [
    { title: "Add the verdict table", subIssue: 201 },
    { title: "Drop the last-slice request", subIssue: 203 },
  ];

  it("writes the pre-upgrade slices first, each with its own row, the first time the table is written", () => {
    const out = addMergedSlice("Closes #171\n", { backfill: [], merged: slice({ subIssue: 204 }), preUpgrade });
    const rows = out.split("\n").filter((line) => /\(#\d+\)/.test(line));

    expect(rows).toEqual([
      renderPreUpgradeRow(preUpgrade[0]!),
      renderPreUpgradeRow(preUpgrade[1]!),
      renderSliceRow(slice({ subIssue: 204 })),
    ]);
  });

  it("adds no pre-upgrade row once the table exists", () => {
    const existing = addMergedSlice("Closes #171\n", { backfill: [], merged: slice({ subIssue: 204 }), preUpgrade: [] });
    const out = addMergedSlice(existing, { backfill: [], merged: slice({ subIssue: 205, slicePr: 212 }), preUpgrade });

    expect(out).not.toContain("built before slice PRs");
    expect(out).toContain("(#205)");
  });

  /** A run that died after its merge left that slice rowless (#207); the next run writes it first. */
  it("writes the backfilled slices' rows before the merged slice's, in the order given", () => {
    const existing = addMergedSlice("Closes #171\n", { backfill: [], merged: slice({ subIssue: 204 }), preUpgrade: [] });
    const backfill = [slice({ subIssue: 205, slicePr: 212 }), slice({ subIssue: 206, slicePr: 213 })];
    const out = addMergedSlice(existing, { backfill, merged: slice({ subIssue: 207, slicePr: 214 }), preUpgrade });
    const rows = out.split("\n").filter((line) => /\(#\d+\)/.test(line));

    expect(rows).toEqual([
      renderSliceRow(slice({ subIssue: 204 })),
      ...backfill.map(renderSliceRow),
      renderSliceRow(slice({ subIssue: 207, slicePr: 214 })),
    ]);
  });

  it("writes the pre-upgrade slices before the backfilled ones, when it creates the table", () => {
    const out = addMergedSlice("Closes #171\n", {
      backfill: [slice({ subIssue: 205, slicePr: 212 })],
      merged: slice({ subIssue: 206, slicePr: 213 }),
      preUpgrade,
    });
    const keys = out.split("\n").flatMap((line) => /\(#(\d+)\) \|/.exec(line)?.[1] ?? []);

    expect(keys).toEqual(["201", "203", "205", "206"]);
  });
});

describe("parseSlicesUpdate", () => {
  it("reads back the facts file the merge step writes", () => {
    const raw = {
      backfill: [
        {
          title: "Add the verdict table",
          subIssue: 201,
          slicePr: 210,
          slicePrUrl: PR_URL,
          verdict: "Accepted. Nothing to fix.",
          openThreads: [],
        },
      ],
      merged: {
        title: "Wire the advance job",
        subIssue: 202,
        slicePr: 211,
        slicePrUrl: PR_URL,
        verdict: null,
        openThreads: [{ path: "a.ts", line: null, url: `${PR_URL}#discussion_r1` }],
      },
      preUpgrade: [{ title: "Add the verdict table", subIssue: 200 }],
    };

    expect(parseSlicesUpdate(raw)).toEqual(raw);
  });

  it("refuses a file missing a fact, rather than writing a row that would stand forever", () => {
    expect(() => parseSlicesUpdate({ backfill: [], merged: { title: "x" }, preUpgrade: [] })).toThrow(/subIssue/);
    expect(() => parseSlicesUpdate({ backfill: [{ title: "x" }], merged: {}, preUpgrade: [] })).toThrow(/backfill\[0\]\.subIssue/);
  });
});
