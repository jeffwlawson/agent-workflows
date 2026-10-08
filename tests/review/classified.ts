import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classify } from "../../review/red-check-classify.js";
import type { Placed } from "../../review/red-check-place.js";
import type { RedCheckReport } from "../../shared/red-check.js";

/** Real reporters' JUnit XML, each named for the reporter that wrote it. */
export const FIXTURES = path.resolve("tests", "fixtures", "red-check");

export const BASE = "b".repeat(40);
export const HEAD = "c".repeat(40);

/** A placement that is ready, of the one test file the fixtures are reports of. */
export const READY: Placed = { status: "ready", head: HEAD, base: BASE, files: ["tests/test_recipes.py"] };

/**
 * The report `review:red-check-classify` writes for the JUnit report `report`
 * in `checkout`, called the way the CLI calls it: `placed` is what
 * `review:red-check-place` wrote, `null` for nothing, and the adopter's install
 * succeeded and their command exited 1, unless `over` says otherwise.
 */
export const classified = (
  report: string,
  over: {
    readonly placed?: Placed | null;
    readonly SETUP_OUTCOME?: string;
    readonly EXIT_CODE?: string;
    readonly checkout?: string;
  } = {},
): RedCheckReport => {
  const placeDir = fs.mkdtempSync(path.join(os.tmpdir(), "red-check-place-"));
  const placed = over.placed === undefined ? READY : over.placed;
  if (placed !== null) fs.writeFileSync(path.join(placeDir, "place.json"), JSON.stringify(placed));
  const written = new Map<string, unknown>();
  classify(
    {
      OUTPUT_DIR: "/out",
      CHECKOUT: over.checkout ?? FIXTURES,
      REPORT_PATH: report,
      SETUP_OUTCOME: over.SETUP_OUTCOME ?? "success",
      EXIT_CODE: over.EXIT_CODE ?? "1",
      PLACE_DIR: placeDir,
    },
    {
      writeJson: (name, value) => written.set(name, value),
      writeText: (name, value) => written.set(name, value),
      appendLine: () => {},
    },
  );
  return written.get("red_check.json") as RedCheckReport;
};
