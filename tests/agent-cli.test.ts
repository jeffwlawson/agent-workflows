import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, run, type CliIo } from "../cli.js";
import { copyAssets } from "../scripts/copy-assets.js";
import { init } from "../setup/init.js";
import { runDoctor, type RepoFacts } from "../setup/doctor.js";

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
   * `init` reads the reference callers out of the tarball the same way a runner
   * reads its prompt — at a path relative to its own module — so they are an
   * asset of exactly the kind this step exists for. `tsc` would leave them
   * behind, and the symptom is an `init` that works in a checkout and finds
   * nothing at all once published.
   */
  it("ships the reference callers init copies", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-assets-"));
    try {
      copyAssets(PACKAGE_DIR, out);

      const callers = fs
        .readdirSync(path.join(PACKAGE_DIR, "examples", "callers"))
        .filter((entry) => entry.endsWith(".yml"));

      expect(callers).not.toHaveLength(0);
      for (const file of callers) {
        expect(fs.readFileSync(path.join(out, "examples", "callers", file), "utf8")).toBe(
          fs.readFileSync(path.join(PACKAGE_DIR, "examples", "callers", file), "utf8"),
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

/**
 * The second surface (#6). `init` and `doctor` are the **install path** rather
 * than runners: they are run by a human at a terminal, in somebody else's
 * checkout, and they take arguments — which is why they do not live in a
 * `<name>/<name>.ts` directory and why the table above says *every runner is a
 * command* and never the reverse.
 *
 * They are subcommands of the same binary on purpose. The version that writes a
 * pin has to be the version that pin names, and the version that diagnoses a
 * loop has to be the one whose guards it knows about — one install, one version,
 * no second thing to keep in step.
 */
describe("init installs the reference callers into an adopting repo", () => {
  /** An adopter's checkout: a repository, and nothing this loop put there. */
  const adopter = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-init-"));
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    return root;
  };

  const roots: string[] = [];
  const adopted = (): string => {
    const root = adopter();
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const read = (root: string, rel: string): string =>
    fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");

  const referenceNames = fs
    .readdirSync(path.join("examples", "callers"))
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => entry.replace(/\.yml$/, ""))
    .sort();

  it("writes one caller per reference file, pinned to this package's own version", async () => {
    const root = adopted();

    const changes = await init({ dir: root });

    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => c.action)).toEqual(
      referenceNames.map(() => "created"),
    );
    for (const name of referenceNames) {
      const text = read(root, `.github/workflows/agent-${name}.yml`);
      expect(text).toContain(`/.github/workflows/${name}.yml@v${manifest.version}`);
      expect(text).toContain("packages: read");
    }
  });

  /**
   * `self-check` is `<caller job id> / <called job id>` and is the one value in
   * a caller that nothing can read from the other side — so `init` composes it
   * from the job id it is actually writing rather than copying the reference's.
   */
  it("composes self-check from the job id it writes", async () => {
    const root = adopted();

    await init({ dir: root });

    expect(read(root, ".github/workflows/agent-review.yml")).toMatch(
      /^\s*self-check: review \/ review$/m,
    );
  });

  /**
   * Re-run updates rather than refusing (the opposite of upstream's `init`,
   * which tells you to remove it first): the commonest reason to run this twice
   * is a new release, and a scaffolder that refuses the second run is one an
   * adopter works around by hand. Their own edits to the job id survive it,
   * which is what makes an update safe to take — and `self-check` is recomposed
   * around the id they chose rather than reset to ours.
   */
  it("updates on a re-run, keeping a renamed job id and recomposing self-check", async () => {
    const root = adopted();
    await init({ dir: root });
    const renamed = read(root, ".github/workflows/agent-review.yml")
      .replace(/^  review:$/m, "  agent_review:")
      .replace(/self-check: review \/ review/, "self-check: agent_review / review")
      .replace(`@v${manifest.version}`, "@v0.0.1");
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-review.yml"), renamed);

    const changes = await init({ dir: root });

    const text = read(root, ".github/workflows/agent-review.yml");
    expect(text).toMatch(/^  agent_review:$/m);
    expect(text).toMatch(/^\s*self-check: agent_review \/ review$/m);
    expect(text).toContain(`@v${manifest.version}`);
    expect(changes.find((c) => c.file.endsWith("agent-review.yml"))?.action).toBe("updated");
  });

  it("reports an unchanged caller rather than rewriting it", async () => {
    const root = adopted();
    await init({ dir: root });

    const changes = await init({ dir: root });

    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => c.action)).toEqual(
      referenceNames.map(() => "unchanged"),
    );
  });

  /**
   * The judgement work, handed to the adopter's own agent the way sandcastle's
   * `init` hands over a tracker it cannot configure: secrets, a repository
   * setting, the labels, and the two documents that decide whether the output is
   * any good. None of it is detectable from a checkout.
   */
  it("emits a SETUP.md prompt for the work it cannot do", async () => {
    const root = adopted();

    await init({ dir: root });

    const setup = read(root, "SETUP.md");
    expect(setup).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(setup).toContain("AGENT_PAT");
    expect(setup).toContain("agent:in-progress");
    expect(setup).toContain("doctor");
    expect(setup).toContain(manifest.name);
  });

  /**
   * `SETUP.md` is a name an adopter may already be using. Overwriting the
   * callers is the point; overwriting a document somebody wrote is not, so the
   * one file that is not ours by construction is the one that carries a marker
   * and is left alone without it.
   */
  it("leaves a SETUP.md it did not write alone, and says so", async () => {
    const root = adopted();
    fs.writeFileSync(path.join(root, "SETUP.md"), "# How we set this repo up\n");

    const changes = await init({ dir: root });

    expect(read(root, "SETUP.md")).toBe("# How we set this repo up\n");
    const change = changes.find((c) => c.file === "SETUP.md");
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toMatch(/not written by/i);
  });

  it("is reachable as a subcommand and takes a directory", async () => {
    const root = adopted();

    const { code, out } = await invoke(["init", "--dir", root]);

    expect(code).toBe(0);
    expect(out).toContain("agent-implement.yml");
    expect(fs.existsSync(path.join(root, "SETUP.md"))).toBe(true);
  });

  it("refuses a flag it does not know rather than ignoring it", async () => {
    const { code, err } = await invoke(["init", "--force"]);

    expect(code).toBe(2);
    expect(err).toContain("--force");
  });
});

/**
 * `doctor` is the other half: every check below is a failure `docs/ADOPTING.md`
 * §1 describes as announcing itself as something else. The facts it cannot read
 * from a checkout — the secrets, the repository setting, the labels, this repo's
 * releases — are gathered through `gh` and passed in, so the diagnosis is
 * exercised here without depending on whoever is running the suite being
 * authenticated to anything.
 */
describe("doctor names the failures that otherwise look like something else", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A repository `init` has just finished with — the state doctor should pass. */
  const installed = async (): Promise<string> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    await init({ dir: root });
    return root;
  };

  /** Everything `gh` would have answered, on a correctly configured repository. */
  const healthy = (): RepoFacts => ({
    secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "AGENT_PAT"],
    canCreatePullRequests: true,
    labels: [
      "agent:implement",
      "agent:review",
      "agent:fix",
      "agent:update-branch",
      "agent:in-progress",
      "agent:blocked",
    ],
    visibility: "private",
    releases: [`v${manifest.version}`],
  });

  /**
   * Break one caller, and insist that the break landed. Every scenario below is
   * a text edit against the real reference callers, so a comment reworded there
   * would otherwise turn a scenario into a test of nothing that still passes.
   */
  const edit = (root: string, file: string, change: (text: string) => string): void => {
    const full = path.join(root, ".github", "workflows", file);
    const before = fs.readFileSync(full, "utf8");
    const after = change(before);

    expect(after).not.toBe(before);
    fs.writeFileSync(full, after);
  };

  const check = async (
    root: string,
    facts: RepoFacts,
  ): Promise<{ code: number; out: string; err: string }> => {
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
    return { code: await runDoctor({ dir: root, facts }, io), out, err };
  };

  it("passes a repository init has just set up", async () => {
    const { code, err } = await check(await installed(), healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  it("fails a repository with no caller at all, and names init", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("init");
  });

  it.each([
    ["CLAUDE_CODE_OAUTH_TOKEN", ["AGENT_PAT"]],
    ["AGENT_PAT", ["CLAUDE_CODE_OAUTH_TOKEN"]],
  ])("fails when the %s secret is missing", async (missing: string, present: string[]) => {
    const { code, err } = await check(await installed(), { ...healthy(), secrets: present });

    expect(code).toBe(1);
    expect(err).toContain(missing);
  });

  /**
   * §1's first failure. A PAT bypasses the setting entirely — a user token is
   * not the Actions bot — so the severity depends on the other answer rather
   * than on this one alone.
   */
  it("fails the repository setting only when no PAT makes it moot", async () => {
    const root = await installed();

    const off = await check(root, { ...healthy(), canCreatePullRequests: false });
    expect(off.code).toBe(0);
    expect(off.out).toMatch(/create.*pull request/i);

    const alone = await check(root, {
      ...healthy(),
      canCreatePullRequests: false,
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });
    expect(alone.code).toBe(1);
    expect(alone.err).toMatch(/create.*pull request/i);
  });

  it("fails a caller that dropped packages: read, and names the grant", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *packages: read$/m, ""));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
    expect(err).toContain("agent-fix.yml");
  });

  /**
   * The sixth silent failure, and the one that only exists on a private repo:
   * the check-runs API serves a public repository without the scope, so v0.1.0
   * through v0.1.4 shipped without it and nothing failed until the first private
   * adopter reviewed with no CI evidence at all.
   */
  it("fails a private repo's review caller without checks: read, and warns a public one", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^ *checks: read$/m, ""));

    const isPrivate = await check(root, healthy());
    expect(isPrivate.code).toBe(1);
    expect(isPrivate.err).toContain("checks: read");

    const isPublic = await check(root, { ...healthy(), visibility: "public" });
    expect(isPublic.code).toBe(0);
    expect(isPublic.out).toContain("checks: read");
  });

  /**
   * `permissions: write-all` is a string where the block is usually a map, and a
   * blanket grant really does include the scope. Telling someone to add a
   * permission they already hold is the one thing a preflight cannot afford: a
   * wrong finding is how a list of real ones stops being read.
   */
  it("does not invent a missing grant on a caller that granted everything", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^    permissions:\n(?:.*\n)*?    # No `with:`/m, "    permissions: write-all\n    # No `with:`"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).not.toContain("packages: read");
    expect(code).toBe(0);
  });

  it("fails a caller pinned to a branch rather than a tag or a SHA", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@main"));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toMatch(/tag|sha/i);
  });

  /**
   * Pin *shape* is what the check above covers, and freshness is the one that
   * has actually rotted: the repository this loop was piloted on sat four
   * releases behind, silently. A report rather than a failure — a stale pin is
   * a working loop on an old version, not a broken one.
   */
  it("reports how many releases a pin is behind, without failing on it", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@v0.1.1"));

    const { code, out } = await check(root, {
      ...healthy(),
      releases: [`v${manifest.version}`, "v0.1.3", "v0.1.2", "v0.1.1"],
    });

    expect(code).toBe(0);
    expect(out).toContain("3 releases behind");
  });

  /**
   * The tags endpoint answers a page at a time, so the pin most likely to have
   * rotted is the one most likely to have fallen off the end of it. Reporting
   * nothing there would make the stalest pins the quiet ones — the exact
   * inversion this check exists to undo.
   */
  it("still reports a pin older than the latest tag it could not find in the list", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(`@v${manifest.version}`, "@v0.0.1"));

    const { code, out } = await check(root, { ...healthy(), releases: [`v${manifest.version}`] });

    expect(code).toBe(0);
    expect(out).toMatch(/older than/);
  });

  it("fails a missing trigger label and gives the command that creates it", async () => {
    const root = await installed();
    const facts = healthy();

    const { code, err } = await check(root, {
      ...facts,
      labels: (facts.labels ?? []).filter((name) => name !== "agent:blocked"),
    });

    expect(code).toBe(1);
    expect(err).toContain("agent:blocked");
    expect(err).toContain("gh label create");
  });

  /**
   * `self-check` has no runtime symptom at all: a job that does not recognise
   * its own check run waits for itself, for 15 of its 20 minutes, and then
   * reviews on degraded evidence.
   */
  it("fails a self-check that does not name the job it is in", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^  review:$/m, "  reviewer:"));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("self-check");
  });

  /** A fact `gh` could not answer is reported as unknown, never as a pass. */
  it("says what it could not read rather than treating it as fine", async () => {
    const { code, out } = await check(await installed(), {
      secrets: undefined,
      canCreatePullRequests: undefined,
      labels: undefined,
      visibility: undefined,
      releases: undefined,
    });

    expect(code).toBe(0);
    expect(out).toMatch(/could not/i);
  });

  /**
   * The same reasoning as every runner's `fail()`: a doctor run that is part of
   * a workflow has to leave its reason somewhere the `if: failure()` step can
   * put in front of a human.
   */
  it("writes its reasons where a workflow can read them", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *packages: read$/m, ""));

    await check(root, healthy());

    expect(fs.readFileSync(path.join(scratch, "failure_reason.txt"), "utf8")).toContain(
      "packages: read",
    );
  });

  it("is reachable as a subcommand and refuses a flag it does not know", async () => {
    expect(Object.keys(COMMANDS)).toContain("doctor");

    const { code, err } = await invoke(["doctor", "--fix"]);

    expect(code).toBe(2);
    expect(err).toContain("--fix");
  });
});
