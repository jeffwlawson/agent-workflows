import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, run, type CliIo } from "../cli.js";
import { copyAssets } from "../scripts/copy-assets.js";

/**
 * The runners ship as one versioned package with one binary (#96), so the entry
 * point is a subcommand table rather than five scripts addressed by path. Two
 * properties are worth holding mechanically:
 *
 * - **every runner is reachable.** A workflow directory with no table entry is a
 *   runner that exists and cannot be invoked, and nothing else would notice —
 *   the old form named the file directly, so adding one was self-wiring.
 * - **every asset a runner reads is shipped.** `files: ["dist"]` publishes
 *   compiled JS and nothing else, so a prompt that the build does not copy
 *   resolves to a path that exists in the source tree and not in the tarball.
 *   That failure only appears on a published version, in CI, in another repo.
 *
 * The table is deliberately open: `init` and `doctor` (#112) are two more
 * entries, so the checks below say *every runner is a command*, never *every
 * command is a runner*.
 */

const PACKAGE_DIR = ".";

/**
 * A workflow directory is one holding a runner named after it —
 * `implement/implement.ts`. Found by walking, so a runner added later is held to
 * the same rule on arrival: `shared/` and `scripts/` have no such file and drop
 * out without being listed.
 */
const runnerDirs = fs
  .readdirSync(PACKAGE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => fs.existsSync(path.join(PACKAGE_DIR, name, `${name}.ts`)))
  .sort();

const manifest = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
) as { name: string; version: string };

interface Captured {
  code: number;
  out: string;
  err: string;
}

const invoke = async (argv: string[]): Promise<Captured> => {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { code: await run(argv, io), out, err };
};

/**
 * Every runner writes its failure reason to `OUTPUT_DIR` so the workflow's
 * `if: failure()` step can put it on the issue or PR. Point it at scratch for
 * the duration rather than letting the default (`/tmp`) collect test debris.
 */
let scratch = "";
const previousOutputDir = process.env["OUTPUT_DIR"];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cli-"));
  process.env["OUTPUT_DIR"] = scratch;
});

afterEach(() => {
  if (previousOutputDir === undefined) delete process.env["OUTPUT_DIR"];
  else process.env["OUTPUT_DIR"] = previousOutputDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the runner CLI dispatches on a subcommand", () => {
  it("finds the runners to check", () => {
    expect(runnerDirs).toEqual(["fix", "implement", "implement-prd", "review", "update-branch"]);
  });

  it.each(runnerDirs)("%s: is reachable as a subcommand", (name: string) => {
    expect(Object.keys(COMMANDS)).toContain(name);
  });

  it("lists every command in its usage", async () => {
    const { code, out } = await invoke(["help"]);

    expect(code).toBe(0);
    for (const name of Object.keys(COMMANDS)) expect(out).toContain(name);
  });

  /**
   * The version the workflow pinned is the one question a run's log has to be
   * able to answer, for the same reason the model id is echoed: "which runner
   * produced this?" is asked of every output that looks wrong, and the answer
   * must not require knowing what the YAML said that week.
   */
  it("reports its own version", async () => {
    const { code, out } = await invoke(["--version"]);

    expect(code).toBe(0);
    expect(out.trim()).toBe(manifest.version);
  });

  /**
   * A mistyped subcommand is a workflow-YAML error, and the YAML is now the
   * base-controlled half — so it fails on the first run after the edit, at which
   * point the reason has to reach the human rather than the log. `fail()`'s
   * reasoning exactly: an issue comment that can only say "check the logs" is
   * one nobody checks.
   */
  it("refuses an unknown command, and says so where the workflow can read it", async () => {
    const { code, err } = await invoke(["implment"]);

    expect(code).toBe(2);
    expect(err).toContain("implment");
    expect(fs.readFileSync(path.join(scratch, "failure_reason.txt"), "utf8")).toContain("implment");
  });

  it("refuses an empty argv with usage", async () => {
    const { code, err } = await invoke([]);

    expect(code).toBe(2);
    expect(err).toContain("Usage");
  });

  /**
   * A runner takes its input from the environment, so an argument to one is a
   * misunderstanding of the interface — silently ignoring it would run the real
   * thing while the author believes a flag took effect. Refused *before* the
   * runner module is loaded: importing it starts the run, which is also why a
   * regression here fails by hanging or exiting the test process rather than by
   * a red assertion.
   *
   * The handover line is asserted on the same invocation, since it is printed
   * before the runner is reached: every run says which version it is on, for the
   * reason `shared/common.ts` echoes the model id.
   */
  it("refuses arguments to a runner rather than ignoring them", async () => {
    const { code, out, err } = await invoke(["review", "--dry-run"]);

    expect(code).toBe(2);
    expect(err).toContain("--dry-run");
    expect(out).toContain(`agent-workflows ${manifest.version}: review`);
  });
});

/**
 * The publish step. `tsc` emits `.js` and nothing else, so every `.md` a runner
 * reads at `import.meta.dirname` has to be copied into the same relative place
 * under `dist/` — otherwise the prompt resolves in a checkout and not in the
 * tarball, which is the one environment nothing here exercises.
 */
describe("the build ships every prompt beside its runner", () => {
  const mdFilesUnder = (dir: string, prefix = ""): readonly string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return ["dist", "node_modules", "output", "docs"].includes(entry.name)
            ? []
            : mdFilesUnder(path.join(dir, entry.name), rel);
        }
        return entry.name.endsWith(".md") ? [rel] : [];
      })
      .sort();

  it("copies each one to the same relative path", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      const shipped = mdFilesUnder(PACKAGE_DIR).filter((rel) => rel.includes("/"));

      expect(shipped).not.toHaveLength(0);
      for (const rel of shipped) {
        expect(fs.readFileSync(path.join(out, rel), "utf8")).toBe(
          fs.readFileSync(path.join(PACKAGE_DIR, rel), "utf8"),
        );
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  /**
   * The package's own README is documentation for whoever installs it, not an
   * asset a runner resolves — shipping it into `dist/` would put a second copy
   * beside `cli.js` for npm to serve from the tarball root anyway.
   */
  it("leaves the package's own documentation out of dist", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      expect(fs.existsSync(path.join(out, "README.md"))).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  /**
   * And neither is `docs/`. This one is load-bearing rather than tidy: while the
   * package lived at `.sandcastle/agent-workflows/` inside the linter, the repo's
   * `docs/` was outside it and unreachable by the walk. At a repository root it is
   * a sibling of the runner directories and looks exactly like one, so the walk
   * that exists to make sure no prompt is ever forgotten will happily ship
   * `friction.md`, `ADOPTING.md` and `parity.md` to every consumer — 30 kB to
   * 102 kB — unless it is told not to.
   */
  it("leaves docs/ out of dist", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      expect(fs.existsSync(path.join(out, "docs"))).toBe(false);
      expect(fs.existsSync(path.join(PACKAGE_DIR, "docs/ADOPTING.md"))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});
