import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS, run, type CliIo } from "../cli.js";
import { copyAssets } from "../scripts/copy-assets.js";
import { callersIn } from "../setup/callers.js";
import {
  ADVISORY_LABELS,
  advisoryLabelSpecsFor,
  init,
  labelCommand,
  POLICY_CHANGE,
  labelSpecsFor,
  STATE_LABELS,
  TRIGGER_LABELS,
} from "../setup/init.js";
import {
  asVisibility,
  availableSecrets,
  parseList,
  REQUIRED_PERMISSIONS,
  runDoctor,
  type RepoFacts,
} from "../setup/doctor.js";
import {
  livePolicySurface,
  parsePolicies,
  POLICY_NAME,
  readPolicies,
  type ActionsPolicy,
  type PolicyBody,
  type PolicySurface,
} from "../setup/policies.js";

/**
 * The Actions policy step, for the tests that are not about it: a private
 * repository, which it leaves alone, and a write that fails the test rather
 * than reaching anything. `init` takes its surface as a required option, so a
 * test cannot fall through to a live `gh` by leaving it out.
 */
const offline: PolicySurface = {
  visibility: () => "private",
  policies: () => [],
  create: () => {
    throw new Error("init wrote an Actions policy in a test that is not about it");
  },
  update: () => {
    throw new Error("init wrote an Actions policy in a test that is not about it");
  },
};

/**
 * `gh` as the replay in `tests/fixtures/gh-replay`, for the tests that run the
 * live policy surface. Its policy list has the real list's shape, with no
 * `conditions` or `rules` (#238), so a reader that rules on the list rather
 * than on each policy's own endpoint sees nothing allowed and fails here.
 * `policies` are served in full from the per-id endpoint, and what `init`
 * wrote is read back from `GH_REPLAY_LOG`, one call per line.
 */
const replayed = <T>(
  scenario: { visibility?: string; policies?: readonly object[]; unreadable?: readonly number[] },
  body: () => T,
): { result: T; writes: unknown[][] } => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-gh-replay-"));
  const log = path.join(temp, "writes.log");
  const policies = path.join(temp, "policies.json");
  fs.writeFileSync(policies, JSON.stringify(scenario.policies ?? []));
  const env: Record<string, string> = {
    PATH: `${path.resolve("tests", "fixtures", "gh-replay")}${path.delimiter}${process.env["PATH"] ?? ""}`,
    GH_REPLAY_LOG: log,
    GH_REPLAY_POLICIES: policies,
    ...(scenario.visibility === undefined ? {} : { GH_REPLAY_VISIBILITY: scenario.visibility }),
    ...(scenario.unreadable === undefined ? {} : { GH_REPLAY_POLICY_FAILURE: scenario.unreadable.join(",") }),
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const result = body();
    const written = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { result, writes: written.map((line) => JSON.parse(line) as unknown[]) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
};

/**
 * The runners ship as one versioned package with one binary
 * (jeffwlawson/winget-manifest-lint#96), so the entry point is a subcommand
 * table rather than five scripts addressed by path. Two properties are worth
 * holding mechanically:
 *
 * - **every runner is reachable.** A workflow directory with no table entry is a
 *   runner that exists and cannot be invoked, and nothing else would notice —
 *   the old form named the file directly, so adding one was self-wiring.
 * - **every asset a runner reads is shipped.** `files: ["dist"]` publishes
 *   compiled JS and nothing else, so a prompt that the build does not copy
 *   resolves to a path that exists in the source tree and not in the tarball.
 *   That failure only appears on a published version, in CI, in another repo.
 *
 * The table is deliberately open: `init` and `doctor`
 * (jeffwlawson/winget-manifest-lint#112) are two more entries, so the checks
 * below say *every runner is a command*, never *every command is a runner*.
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
    expect(runnerDirs).toEqual([
      "fix",
      "follow-ups",
      "implement",
      "implement-prd",
      "review",
      "update-branch",
    ]);
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
  it.each(runnerDirs)(
    "%s: refuses arguments rather than ignoring them",
    async (name: string) => {
      const { code, out, err } = await invoke([name, "--dry-run"]);

      expect(code).toBe(2);
      expect(err).toContain("--dry-run");
      expect(out).toContain(`agent-workflows ${manifest.version}: ${name}`);
    },
  );

  /**
   * `follow-ups` (#49) is the one runner that runs no model, and that is a
   * security property rather than an implementation detail: its workflow is the
   * only one in the loop holding `issues: write`, and a model reading arbitrary
   * issue bodies while holding it is a prompt-injection surface nothing here
   * currently has. So no prompt, no extraction, no agent.
   *
   * Asserted over the source because nothing else can see it. The permissions
   * half is the workflow's to state; this half is invisible until something
   * imports `claudeAgent` and the loop quietly grows a sixth model call.
   */
  it("follow-ups runs no model and holds no prompt", () => {
    const dir = path.join(PACKAGE_DIR, "follow-ups");

    expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".md"))).toEqual([]);
    const source = fs.readFileSync(path.join(dir, "follow-ups.ts"), "utf8");
    expect(source).not.toContain("claudeAgent");
    expect(source).not.toContain("sandcastle");
    expect(source).not.toContain("runWithExtraction");
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

    const changes = await init({ dir: root, github: offline });

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
   * `self-check` is `<caller job id> / <called job id>` and is the one coupling
   * in a caller with no runtime symptom, so nothing is written without it
   * naming the job it sits in — `assertCoupled` reads the result back rather
   * than trusting that a rewrite was applied.
   */
  it("writes a self-check naming the job it sits in", async () => {
    const root = adopted();

    await init({ dir: root, github: offline });

    expect(read(root, ".github/workflows/agent-review.yml")).toMatch(
      /^\s*self-check: review \/ review$/m,
    );
  });

  /**
   * Re-run updates rather than refusing (the opposite of upstream's `init`,
   * which tells you to remove it first): the commonest reason to run this twice
   * is a new release, and a scaffolder that refuses the second run is one an
   * adopter works around by hand.
   *
   * But an update is the **pin and nothing else**. A caller is the half an
   * adopter owns, and everything in this scenario is something they really do
   * set: the `with:` inputs `docs/ADOPTING.md` §4 ships commented out — a pnpm
   * repo whose `setup:` were reverted here dies at `npm ci` with nothing saying
   * why — a renamed job, and a permission of their own. A re-run that rewrote
   * the file from the reference would revert all of it and report `updated`,
   * which is the failure class this command exists to remove.
   */
  it("moves the pin on a re-run and changes nothing else in a caller", async () => {
    const root = adopted();
    await init({ dir: root, github: offline });
    const theirs = read(root, ".github/workflows/agent-review.yml")
      .replace(/^  review:$/m, "  agent_review:")
      .replace(/self-check: review \/ review/, "self-check: agent_review / review")
      .replace(/^(    with:)$/m, "$1\n      default-branch: trunk\n      node-version-file: .tool-versions\n      setup: pnpm i --frozen-lockfile")
      .replace(/^      pull-requests: write$/m, "      pull-requests: write\n      issues: write")
      .replace(`@v${manifest.version}`, "@v0.0.1");
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-review.yml"), theirs);

    const changes = await init({ dir: root, github: offline });

    const text = read(root, ".github/workflows/agent-review.yml");
    expect(text).toBe(theirs.replace("@v0.0.1", `@v${manifest.version}`));
    // Named as well as compared, so an edit above that silently matched
    // nothing cannot leave this asserting that two identical files are equal.
    expect(text).toContain("setup: pnpm i --frozen-lockfile");
    expect(text).toContain("default-branch: trunk");
    expect(text).toContain("issues: write");
    expect(text).toMatch(/^  agent_review:$/m);
    expect(changes.find((c) => c.file.endsWith("agent-review.yml"))?.action).toBe("updated");
  });

  /**
   * A caller an adopter deleted is a subset they chose — §4 says to take the
   * ones you want — and a re-run is how you take a release, not how you get the
   * loop's opinion about your workflows back. It is named rather than written,
   * so the same report also tells an adopter that a workflow added in a later
   * release exists at all, instead of a `pull_request_target` trigger appearing
   * in their tree behind them.
   */
  it("does not put back a caller the adopter deleted, and says it did not", async () => {
    const root = adopted();
    await init({ dir: root, github: offline });
    fs.rmSync(path.join(root, ".github", "workflows", "agent-update-branch.yml"));

    const changes = await init({ dir: root, github: offline });

    expect(fs.existsSync(path.join(root, ".github", "workflows", "agent-update-branch.yml"))).toBe(
      false,
    );
    const change = changes.find((c) => c.file.endsWith("agent-update-branch.yml"));
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toContain("examples/callers/update-branch.yml");
  });

  /**
   * The filename is ours by convention only. A workflow of an adopter's own
   * that happens to be called `agent-fix.yml` is a file this never wrote, and
   * overwriting it is the same act the re-run above refuses — with worse
   * consequences, since nothing in it was ever a caller.
   */
  it("refuses to write over a file of the same name that is not a caller", async () => {
    const root = adopted();
    const theirs = "name: Our own fix job\non: workflow_dispatch\njobs:\n  fix:\n    runs-on: ubuntu-latest\n";
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-fix.yml"), theirs);

    const changes = await init({ dir: root, github: offline });

    expect(read(root, ".github/workflows/agent-fix.yml")).toBe(theirs);
    expect(changes.find((c) => c.file.endsWith("agent-fix.yml"))?.action).toBe("kept");
  });

  it("reports an unchanged caller rather than rewriting it", async () => {
    const root = adopted();
    await init({ dir: root, github: offline });

    const changes = await init({ dir: root, github: offline });

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

    await init({ dir: root, github: offline });

    const setup = read(root, "SETUP.md");
    expect(setup).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(setup).toContain("AGENT_PAT");
    expect(setup).toContain("agent:in-progress");
    expect(setup).toContain("doctor");
    expect(setup).toContain(manifest.name);
  });

  /**
   * `SETUP.md` is the adopter's judgement work, and in this package's own
   * repository it is noise at the root of a tree that already does that work
   * (#238). The callers are still pinned, since this repository runs them.
   */
  it("writes no SETUP.md into the package's own repository", async () => {
    const root = adopted();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: manifest.name }));

    const changes = await init({ dir: root, github: offline });

    expect(fs.existsSync(path.join(root, "SETUP.md"))).toBe(false);
    const change = changes.find((c) => c.file === "SETUP.md");
    expect(change?.action).toBe("kept");
    expect(change?.note).toContain(manifest.name);
    expect(changes.filter((c) => c.file.endsWith(".yml")).every((c) => c.action === "created")).toBe(true);
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

    const changes = await init({ dir: root, github: offline });

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

  /**
   * The CLI is the one caller of the live policy surface, and it runs inside
   * agent jobs whose environment sets `GH_REPO` to the repository the job is
   * for. The surface asks about the checkout it was given and nothing else, so
   * outside a checkout it reads nothing and writes nothing. A stand-in `gh`
   * records what it was asked, and under what `GH_REPO`.
   */
  it.skipIf(process.platform === "win32")("asks gh about the target checkout only, never GH_REPO", async () => {
    const root = adopted();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fake-gh-"));
    roots.push(bin);
    const log = path.join(bin, "calls.log");
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\necho "GH_REPO=\${GH_REPO:-} $*" >> "${log}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const saved = { PATH: process.env["PATH"], GH_REPO: process.env["GH_REPO"] };
    process.env["PATH"] = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    process.env["GH_REPO"] = "acme/live";
    try {
      const { code, out } = await invoke(["init", "--dir", root]);

      expect(code).toBe(0);
      expect(out).toMatch(/kept\s+Actions policy/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual(["GH_REPO= repo view --json visibility --jq .visibility"]);
  });

  it("refuses a flag it does not know rather than ignoring it", async () => {
    const { code, err } = await invoke(["init", "--force"]);

    expect(code).toBe(2);
    expect(err).toContain("--force");
  });

  /**
   * A `--dir` that is not there is a typo rather than a request, and `put`
   * mkdirs recursively: it would scaffold a whole repository under a directory
   * nobody has — reporting the same repo-relative lines a correct run does,
   * with the repository being adopted untouched. Refused as bad usage, which is
   * what a mistyped path is, and on the same grounds as the `SETUP.md` and the
   * filename this will not write over.
   */
  it("refuses a --dir that does not exist rather than scaffolding one", async () => {
    const missing = path.join(os.tmpdir(), "agent-init-absent", "typo", "path");

    const { code, err } = await invoke(["init", "--dir", missing]);

    expect(code).toBe(2);
    expect(err).toContain(missing);
    expect(fs.existsSync(missing)).toBe(false);
  });

  /**
   * And a `--dir` that exists but is a *file* is the same typo with a worse
   * ending: `put`'s recursive mkdir throws `ENOTDIR` from inside the
   * scaffolding, so the same mistake exits 1 with a message about a directory
   * nobody named. Both commands take it, so both are checked.
   */
  it.each(["init", "doctor"])("refuses a --dir that is a file rather than a directory", async (command: string) => {
    const file = path.join(os.tmpdir(), `agent-dir-file-${command}-${process.pid}`);
    fs.writeFileSync(file, "");
    try {
      const { code, err } = await invoke([command, "--dir", file]);

      expect(code).toBe(2);
      expect(err).toContain(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  /** And where it did work, since every other line it prints is repo-relative. */
  it("names the directory it worked in", async () => {
    const root = adopted();

    const { out } = await invoke(["init", "--dir", root]);

    expect(out).toContain(path.resolve(root));
  });

  /**
   * Every `{{…}}` in the template has a substitution behind it. One added to
   * `setup/SETUP.md` without a `replaceAll` for it ships as literal braces into
   * an adopter's tree, inside a command they are told to run.
   */
  it("leaves no placeholder unsubstituted in the prompt it writes", async () => {
    const root = adopted();

    await init({ dir: root, github: offline });

    expect(read(root, "SETUP.md")).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  /**
   * Every `gh label create` block §3 ships, in the order it ships them: the
   * labels it **mandates** first, then the ones it documents conditionally.
   * Scoped to §3 so a block added to another section cannot become the first.
   */
  const documentedLabels = (): readonly { name: string; color: string; description: string }[][] =>
    ((fs
      .readFileSync(path.join("docs", "ADOPTING.md"), "utf8")
      .split(/^(?=## )/m)
      .find((section) => section.startsWith("## 3.")) ?? "").match(/```bash\n[\s\S]*?```/g) ?? [])
      .map((block) =>
        [
          ...block.matchAll(/^gh label create +"([^"]+)" +--color +(\S+) +--description +"([^"]+)"$/gm),
        ].map(([, name, color, description]) => ({
          name: name ?? "",
          color: color ?? "",
          description: description ?? "",
        })),
      )
      .filter((block) => block.length > 0);

  const byName = (labels: readonly { name: string }[]) =>
    [...labels].sort((a, b) => a.name.localeCompare(b.name));

  /**
   * The label table in `setup/init.ts` is a **second copy** of `docs/ADOPTING.md`
   * §3: the doc is what a human reads, the table is what `SETUP.md` tells them
   * to run and what `doctor` demands exists. Nothing else holds the two in step,
   * and a rename in either place — or in the `if:` a workflow filters on — would
   * leave `init` scaffolding one string and the loop waiting for another, which
   * is a transition that no-ops rather than anything that errors.
   *
   * So this is `PIN`'s trick for labels: parse the block the doc actually ships
   * and compare it, colour and description included — **the mandated block**,
   * which is the first of the two §3 now carries (#51).
   */
  it("scaffolds exactly the labels docs/ADOPTING.md §3 mandates", () => {
    const mandated = documentedLabels()[0] ?? [];

    // The block itself has to still be there: a doc restructure that moved it
    // would otherwise make this pass by comparing nothing.
    expect(mandated).toHaveLength(6);
    expect(byName([...TRIGGER_LABELS, ...STATE_LABELS])).toEqual(byName(mandated));
  });

  /**
   * And scaffolds none of the ones it documents **conditionally**.
   *
   * `pr-follow-up` and `needs-triage` matter only to a repository that installed
   * the filing caller, and `agent:follow-ups` is added by a step that warns
   * rather than failing. Putting any of them in the tables above would put them
   * in `SETUP.md` — which is fine — *and* in `doctor`'s missing-label check,
   * which is not: a preflight that fails a correctly-installed loop over a label
   * its workflows never look for is a preflight people learn to ignore.
   *
   * Asserted from the doc rather than from a list, so a fourth conditional label
   * is covered by arriving in that block. The block has to exist for the same
   * reason the one above does.
   */
  it("scaffolds none of the labels §3 documents conditionally", () => {
    const conditional = documentedLabels().slice(1).flat();
    const scaffolded = new Set([...TRIGGER_LABELS, ...STATE_LABELS].map((label) => label.name));
    // The function `doctor` demands from, named rather than inferred from the
    // tables: what must not happen is a preflight erroring over one of these.
    const demanded = new Set(labelSpecsFor(referenceNames).map((label) => label.name));

    expect(conditional.length).toBeGreaterThan(0);
    for (const label of conditional) {
      expect(scaffolded).not.toContain(label.name);
      expect(demanded).not.toContain(label.name);
    }
  });

  /**
   * …and **names** them in the `SETUP.md` it writes, which is the other half of
   * that decision rather than a contradiction of it (#54).
   *
   * `init` scaffolds the filing caller on a first run, so an adopter who ran it
   * has a live feature whose three labels no artifact they hold mentions — the
   * review marks nothing, the stubs file unlabelled, and the only signal is a
   * `::warning::` inside a green run, which is §1's own signature. Telling them
   * is free; failing them over it is what `doctor` still declines to do.
   *
   * Compared against the doc block rather than a list here too, so the third
   * copy of these strings — `ADVISORY_LABELS` — cannot drift from §3 either.
   */
  it("names the conditional labels in the prompt when it installed the caller that wants them", async () => {
    const root = adopted();
    const conditional = documentedLabels().slice(1).flat();

    await init({ dir: root, github: offline });

    expect(byName(advisoryLabelSpecsFor(referenceNames))).toEqual(byName(conditional));
    for (const label of conditional) expect(read(root, "SETUP.md")).toContain(labelCommand(label));
  });

  /**
   * And says nothing about them to a repository that declined that caller (§4).
   * Labels prescribed to a repository where nothing will ever read them are a
   * setup list with a step that cannot be completed for a reason — which is how
   * a checklist stops being worked through.
   *
   * Keyed on the **filing caller's own** advisory labels rather than on every
   * conditional label §3 documents. What is asserted is the per-caller part:
   * the reason the map is a map.
   */
  it("says nothing about them once the caller that wants them is gone", async () => {
    const root = adopted();
    await init({ dir: root, github: offline });

    fs.rmSync(path.join(root, ".github", "workflows", "agent-follow-ups.yml"));
    await init({ dir: root, github: offline });

    const setup = read(root, "SETUP.md");
    const filing = ADVISORY_LABELS["follow-ups"] ?? [];

    expect(filing.length).toBeGreaterThan(0);
    for (const label of filing) {
      expect(setup).not.toContain(label.name);
    }
    // The mandated six are untouched by any of that.
    for (const label of [...TRIGGER_LABELS, ...STATE_LABELS]) {
      expect(setup).toContain(labelCommand(label));
    }
  });
});

/**
 * GitHub blocks `pull_request_target` on a public repository with no event
 * policy allowing it, from 2026-11-02 (#219), and four of the callers run on
 * nothing else. `init` leaves the policy behind it, for those callers' files
 * and no other workflow, and never fails the install over it.
 */
describe("init allows pull_request_target for the loop's callers on a public repository", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** An adopter's checkout, with a CI of their own beside where the callers go. */
  const adopted = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  pull_request_target:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    );
    return root;
  };

  /**
   * GitHub, as far as this step talks to it: a policy list that a create or
   * an update really changes, so a second run reads what the first one wrote.
   */
  const github = (
    visibility: "public" | "private" | undefined,
    start: readonly ActionsPolicy[] | undefined,
    refuse?: string,
  ) => {
    let policies = start;
    const sent: { method: string; id?: number; body: PolicyBody }[] = [];
    const asPolicy = (id: number, body: PolicyBody): ActionsPolicy =>
      parsePolicies(JSON.stringify([{ id, ...body }]))?.[0] as ActionsPolicy;
    const surface: PolicySurface = {
      visibility: () => visibility,
      policies: () => policies,
      create: (body) => {
        sent.push({ method: "POST", body });
        if (refuse !== undefined) return refuse;
        policies = [...(policies ?? []), asPolicy(7, body)];
        return undefined;
      },
      update: (id, body) => {
        sent.push({ method: "PUT", id, body });
        if (refuse !== undefined) return refuse;
        policies = (policies ?? []).map((policy) => (policy.id === id ? asPolicy(id, body) : policy));
        return undefined;
      },
    };
    return { surface, sent };
  };

  const triggered = ["agent-fix.yml", "agent-follow-ups.yml", "agent-review.yml", "agent-update-branch.yml"].map(
    (file) => `.github/workflows/${file}`,
  );

  it("creates the policy for the callers alone, and a second run reports it unchanged", async () => {
    const root = adopted();
    const { surface, sent } = github("public", []);

    const first = await init({ dir: root, github: surface });

    expect(first.find((c) => c.file === POLICY_CHANGE)?.action).toBe("created");
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body;
    expect(body?.name).toBe(POLICY_NAME);
    expect(body?.enforcement).toBe("active");
    // Only the callers that run on the blocked trigger, found by what they
    // call: the adopter's own CI, on the same trigger, stays blocked.
    expect(body?.conditions.workflow_path.include).toEqual(triggered);
    expect(body?.conditions.workflow_path.include).not.toContain(".github/workflows/ci.yml");
    expect(body?.rules).toEqual([{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }]);

    const second = await init({ dir: root, github: surface });

    expect(second.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(1);
  });

  /**
   * Whether `allowed_events` is exhaustive for the files it targets is not
   * documented, so the rule lists every event a targeted caller starts on: a
   * rule naming only the blocked trigger would, if it is, block the rest.
   */
  it("lists every event a targeted caller also triggers on", async () => {
    const root = adopted();
    await init({ dir: root, github: github("private", []).surface });
    const review = path.join(root, ".github", "workflows", "agent-review.yml");
    fs.writeFileSync(review, fs.readFileSync(review, "utf8").replace(/^on:$/m, "on:\n  workflow_dispatch:"));
    const { surface, sent } = github("public", []);

    await init({ dir: root, github: surface });

    expect(sent[0]?.body.rules[0].parameters.allowed_events).toEqual(["pull_request_target", "workflow_dispatch"]);
  });

  it("extends its own policy in place when a caller has been added since", async () => {
    const root = adopted();
    const { surface, sent } = github("public", [
      { id: 3, name: POLICY_NAME, enforcement: "active", include: triggered.slice(1), exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, github: surface });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("updated");
    expect(sent.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "PUT", id: 3 }]);
    expect(sent[0]?.body.conditions.workflow_path.include).toEqual(triggered);
  });

  it("counts a policy somebody else wrote, if it allows the trigger for every caller", async () => {
    const root = adopted();
    const { surface, sent } = github("public", [
      { id: 9, name: "theirs", enforcement: "active", include: [".github/workflows/agent-*.yml"], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, github: surface });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("says nothing and writes nothing on a private repository", async () => {
    const root = adopted();
    const { surface, sent } = github("private", []);

    const changes = await init({ dir: root, github: surface });

    expect(changes.find((c) => c.file === POLICY_CHANGE)).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  /**
   * A token that cannot write the policy is not a failed install: the callers
   * are on disk, and what is left is one call a repository admin makes, named
   * exactly, with the page it can be done on instead.
   */
  it("names the call and the settings page when GitHub refuses it, and still installs", async () => {
    const root = adopted();
    const { surface } = github("public", [], "HTTP 403: Resource not accessible by integration");

    const changes = await init({ dir: root, github: surface });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("kept");
    expect(policy?.note).toContain("HTTP 403");
    expect(policy?.note).toContain("gh api --method POST repos/{owner}/{repo}/actions/policies --input -");
    expect(policy?.note).toContain('"workflow_path":{"include":[".github/workflows/agent-fix.yml"');
    expect(policy?.note).toContain("Settings → Actions → Policies");
    expect(changes.filter((c) => c.file.endsWith(".yml")).every((c) => c.action === "created")).toBe(true);
  });

  /**
   * Against the replay, whose list omits what each policy says (#238): a
   * second run reads the policy the first one created from its own endpoint,
   * finds it allows every caller, and writes nothing.
   */
  it.skipIf(process.platform === "win32")("reads each policy in full, so a re-run leaves its own alone", () => {
    const root = adopted();

    const first = replayed({ visibility: "PUBLIC" }, () => init({ dir: root, github: livePolicySurface(root) }));

    expect(first.result.find((c) => c.file === POLICY_CHANGE)?.action).toBe("created");
    expect(first.writes.map((call) => call.slice(0, 3))).toEqual([["api", "--method", "POST"]]);
    const created = { id: 6133, target: "actions", source_type: "Repository", source: "repo", ...(first.writes[0]?.[4] as object) };

    const second = replayed({ visibility: "PUBLIC", policies: [created] }, () =>
      init({ dir: root, github: livePolicySurface(root) }),
    );

    expect(second.result.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(second.writes).toEqual([]);
  });

  /**
   * A policy whose detail could not be read may be the very one that allows
   * the callers, or this step's own: creating a second beside it, or calling
   * the repository uncovered, would both be verdicts on a fact nobody read.
   */
  it.skipIf(process.platform === "win32")("leaves the policy to a human where one could not be read", () => {
    const root = adopted();
    const theirs = { id: 4, name: "theirs", enforcement: "active" };

    const { result, writes } = replayed({ visibility: "PUBLIC", policies: [theirs], unreadable: [4] }, () =>
      init({ dir: root, github: livePolicySurface(root) }),
    );

    const policy = result.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("kept");
    expect(policy?.note).toContain("Could not read");
    expect(writes).toEqual([]);
  });

  it.each([
    ["visibility", undefined, []],
    ["policies", "public", undefined],
  ] as const)("reports an unreadable %s as a step left to do, never as done", async (_what, visibility, policies) => {
    const root = adopted();
    const { surface, sent } = github(visibility, policies);

    const changes = await init({ dir: root, github: surface });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("kept");
    expect(policy?.note).toContain("gh api --method POST");
    expect(sent).toHaveLength(0);
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

  /**
   * A repository `init` has just finished with, beside a CI of the adopter's
   * own that runs on every pull request: the state doctor should pass. `init`
   * writes no CI, and a repository with none parks the PRD chain (#209).
   */
  const installed = async (): Promise<string> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    await init({ dir: root, github: offline });
    fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), ciOn("  pull_request:"));
    return root;
  };

  /** An adopter's CI, triggered by `on` as given. */
  const ciOn = (...on: readonly string[]): string =>
    ["name: CI", "on:", ...on, "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: true", ""].join("\n");

  /**
   * A caller written by hand rather than copied, for the shapes the reference
   * set does not ship: it puts `permissions:` on the job, and what is worth
   * exercising here is where else an adopter may legally put it.
   */
  const adoptedWith = (top: readonly string[], jobPermissions: readonly string[] = []): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".github", "workflows", "agent-review.yml"),
      [
        "name: Agent Review",
        "on:",
        "  pull_request_target:",
        "    types: [labeled]",
        ...top,
        "jobs:",
        "  review:",
        `    uses: ${manifest.name.replace(/^@/, "")}/.github/workflows/review.yml@v${manifest.version}`,
        ...jobPermissions,
        "    with:",
        "      self-check: review / review",
        // The wires a real caller carries, since every scenario built from this
        // helper is about somewhere *else* being wrong.
        "    secrets:",
        "      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
        "      AGENT_PAT: ${{ secrets.AGENT_PAT }}",
        "",
      ].join("\n"),
    );
    return root;
  };

  /** Everything `gh` would have answered, on a correctly configured repository. */
  const healthy = (): RepoFacts => ({
    secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "AGENT_PAT"],
    canCreatePullRequests: true,
    // The restricted default, which is what a repository created since February
    // 2023 has. Every reference caller declares its own block, so it is the
    // callers that declare *none* the setting decides anything for.
    defaultWorkflowPermissions: "read",
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
    actionsPolicies: [],
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

  /**
   * The Actions policy a public repository needs from 2026-11-02 (#219): a
   * label added there and no run started, with nothing in the loop saying why.
   */
  describe("pull_request_target on a public repository", () => {
    const allowing = (include: readonly string[] | undefined, overrides: Partial<ActionsPolicy> = {}): ActionsPolicy => ({
      id: 1,
      name: "any",
      enforcement: "active",
      include,
      exclude: [],
      allowedEvents: ["pull_request_target"],
      ...overrides,
    });
    const callers = [".github/workflows/agent-fix.yml", ".github/workflows/agent-follow-ups.yml", ".github/workflows/agent-review.yml", ".github/workflows/agent-update-branch.yml"];

    it("is silent where a policy allows it for every caller", async () => {
      const { code, out, err } = await check(await installed(), {
        ...healthy(),
        visibility: "public",
        actionsPolicies: [allowing(callers)],
      });

      expect(`${out}${err}`).not.toContain("pull_request_target policy");
      expect(code).toBe(0);
    });

    it("fails where none does, and names the callers and the fix", async () => {
      const { code, err } = await check(await installed(), { ...healthy(), visibility: "public", actionsPolicies: [] });

      expect(code).toBe(1);
      expect(err).toContain("FAIL  pull_request_target policy");
      for (const file of callers) expect(err).toContain(file);
      expect(err).not.toContain(".github/workflows/agent-implement.yml");
      expect(err).toContain("gh api --method POST repos/{owner}/{repo}/actions/policies");
      expect(err).toContain("Settings → Actions → Policies");
    });

    /** A policy that allows nothing for a caller is no policy for it. */
    it.each([
      ["one caller missing", allowing(callers.slice(1))],
      ["excluded", allowing([], { exclude: [".github/workflows/agent-fix.yml"] })],
      ["only in evaluate mode", allowing(callers, { enforcement: "evaluate" })],
      ["another event only", allowing(callers, { allowedEvents: ["push"] })],
    ] as const)("fails on a policy that is %s", async (_what, policy) => {
      const { code, err } = await check(await installed(), { ...healthy(), visibility: "public", actionsPolicies: [policy] });

      expect(code).toBe(1);
      expect(err).toContain(".github/workflows/agent-fix.yml");
    });

    it("counts a policy on every workflow, or a glob over the callers", async () => {
      for (const policy of [allowing(undefined), allowing(["~ALL"]), allowing([".github/workflows/agent-*.yml"])]) {
        const { code } = await check(await installed(), { ...healthy(), visibility: "public", actionsPolicies: [policy] });
        expect(code).toBe(0);
      }
    });

    /** Unreadable is a thing to check, never "absent". */
    it("warns rather than failing where the policies could not be read", async () => {
      const { code, out, err } = await check(await installed(), { ...healthy(), visibility: "public", actionsPolicies: undefined });

      expect(code).toBe(0);
      expect(err).not.toContain("pull_request_target policy");
      expect(out).toContain("warn  pull_request_target policy: Could not read the Actions policies");
    });

    /**
     * Read the way `gatherFacts` reads them, from the replay whose list omits
     * what each policy says (#238): the policy `init` creates, listed and then
     * read in full, is a pass.
     */
    it.skipIf(process.platform === "win32")("passes on the policy init creates, read the way GitHub serves it", async () => {
      const root = await installed();
      const created = {
        id: 6133,
        name: POLICY_NAME,
        enforcement: "active",
        target: "actions",
        source_type: "Repository",
        source: "repo",
        conditions: { workflow_path: { include: callers, exclude: [] } },
        rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }],
      };

      const { result: actionsPolicies } = replayed({ policies: [created] }, () => readPolicies(root));
      const { code, out, err } = await check(root, { ...healthy(), visibility: "public", actionsPolicies });

      expect(actionsPolicies).toEqual([
        { id: 6133, name: POLICY_NAME, enforcement: "active", include: callers, exclude: [], allowedEvents: ["pull_request_target"] },
      ]);
      expect(`${out}${err}`).not.toContain("pull_request_target policy");
      expect(code).toBe(0);
    });

    /**
     * A parent's policy is read through the repository's own per-id endpoint,
     * the one GitHub's REST description gives an enterprise-sourced example for,
     * and the only one the replay serves. One allowing every caller is a pass.
     */
    it.skipIf(process.platform === "win32")("passes on a parent's policy, read through the repository", async () => {
      const root = await installed();
      const theirs = {
        id: 1,
        name: "Allow the loop",
        target: "actions",
        source_type: "Enterprise",
        source: "enterprise",
        enforcement: "active",
        conditions: { workflow_path: { include: callers, exclude: [] } },
        rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target"] } }],
      };

      const { result: actionsPolicies } = replayed({ policies: [theirs] }, () => readPolicies(root));
      const { code, out, err } = await check(root, { ...healthy(), visibility: "public", actionsPolicies });

      expect(actionsPolicies).toEqual([
        { id: 1, name: "Allow the loop", enforcement: "active", include: callers, exclude: [], allowedEvents: ["pull_request_target"] },
      ]);
      expect(`${out}${err}`).not.toContain("pull_request_target policy");
      expect(code).toBe(0);
    });

    /** One policy unreadable is that policy unknown, and never that policy absent. */
    it.skipIf(process.platform === "win32")("warns rather than failing where one policy could not be read", async () => {
      const root = await installed();

      const { result: actionsPolicies } = replayed({ policies: [{ id: 4, name: "theirs", enforcement: "active" }], unreadable: [4] }, () =>
        readPolicies(root),
      );
      const { code, out, err } = await check(root, { ...healthy(), visibility: "public", actionsPolicies });

      expect(actionsPolicies).toEqual([undefined]);
      expect(code).toBe(0);
      expect(err).not.toContain("pull_request_target policy");
      expect(out).toContain("warn  pull_request_target policy: Could not read");
    });

    it("rules on the policies it could read where those already allow every caller", async () => {
      const { code, out, err } = await check(await installed(), {
        ...healthy(),
        visibility: "public",
        actionsPolicies: [undefined, allowing(callers)],
      });

      expect(`${out}${err}`).not.toContain("pull_request_target policy");
      expect(code).toBe(0);
    });

    it("says nothing on a private repository", async () => {
      const { code, out, err } = await check(await installed(), { ...healthy(), visibility: "private", actionsPolicies: [] });

      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain("pull_request_target");
    });

    it("warns rather than failing where the visibility could not be read", async () => {
      const { code, out } = await check(await installed(), { ...healthy(), visibility: undefined, actionsPolicies: [] });

      expect(code).toBe(0);
      expect(out).toContain("warn  pull_request_target policy");
    });
  });

  /**
   * CI on slice PRs (#209). A slice PR's base is its PRD branch, and a CI
   * filtered to the default branch never runs on one: review reads CI as
   * unknown, a clean slice lands on *Needs a closer look*, and the chain parks
   * at its first slice. Nothing errors, which is why it is looked for here.
   */
  describe("CI on slice PRs", () => {
    const ci = (root: string, text: string, file = "ci.yml"): void => {
      fs.writeFileSync(path.join(root, ".github", "workflows", file), text);
    };

    it("fails a CI filtered to the default branch, names it, and gives the one line", async () => {
      const root = await installed();
      ci(root, ciOn("  pull_request:", "    branches: [main]"));

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      expect(err).toContain("CI on slice PRs");
      expect(err).toContain(".github/workflows/ci.yml");
      expect(err).toContain("branches: [main, 'agent/prd-**']");
    });

    it("fails where nothing but the loop's own workflows triggers on pull_request", async () => {
      const root = await installed();
      ci(root, ciOn("  push:", "    branches: [main]"));

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      expect(err).toContain("No workflow here other than the loop's own triggers on `pull_request`");
    });

    it("does not count a loop caller that also triggers on pull_request", async () => {
      const root = await installed();
      fs.rmSync(path.join(root, ".github", "workflows", "ci.yml"));
      edit(root, "agent-review.yml", (text) => text.replace(/^on:\n/m, "on:\n  pull_request:\n"));

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      expect(err).toContain("CI on slice PRs");
    });

    it.each([
      ["the PRD branches added to the filter", ["  pull_request:", "    branches: [main, 'agent/prd-**']"]],
      ["a single-star PRD pattern", ["  pull_request:", "    branches: [main, 'agent/prd-*']"]],
      ["an ignore list that leaves them in", ["  pull_request:", "    branches-ignore: [gh-pages]"]],
      ["no filter, as a list of events", ["  [push, pull_request]"]],
      ["types but no branch filter", ["  pull_request:", "    types: [opened, synchronize]"]],
    ])("passes %s", async (_case, on) => {
      const root = await installed();
      const text = ciOn(...on).replace("on:\n  [", "on: [");
      ci(root, text);

      const { code, err } = await check(root, healthy());

      expect(err).toBe("");
      expect(code).toBe(0);
    });

    it.each([
      ["an ignore list that names them", ["  pull_request:", "    branches-ignore: ['agent/**']"]],
      ["a later negation that takes them back out", ["  pull_request:", "    branches: ['**', '!agent/prd-**']"]],
      ["a single star, which stops at a slash", ["  pull_request:", "    branches: ['*']"]],
    ])("fails %s", async (_case, on) => {
      const root = await installed();
      ci(root, ciOn(...on));

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      expect(err).toContain("CI on slice PRs");
    });

    it("passes when one workflow of several runs on slice PRs", async () => {
      const root = await installed();
      ci(root, ciOn("  pull_request:", "    branches: [main]"));
      ci(root, ciOn("  pull_request:"), "lint.yml");

      const { code } = await check(root, healthy());

      expect(code).toBe(0);
    });

    /** Unreadable is not a pass, and not a fault either: it could be the one that runs. */
    it("warns rather than passing or failing where a workflow could not be read", async () => {
      const root = await installed();
      ci(root, ciOn("  pull_request:", "    branches: [main]"));
      ci(root, "on: [unclosed\n", "broken.yml");

      const { code, out, err } = await check(root, healthy());

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).toContain("CI on slice PRs");
      expect(out).toContain(".github/workflows/broken.yml");
    });

    it("says nothing where the PRD chain is not installed", async () => {
      const root = await installed();
      fs.rmSync(path.join(root, ".github", "workflows", "agent-implement-prd.yml"));
      ci(root, ciOn("  pull_request:", "    branches: [main]"));

      const { out, err } = await check(root, healthy());

      expect(out + err).not.toContain("CI on slice PRs");
    });
  });

  /**
   * The review caller's `closed` trigger (#209), which moves the PRD chain on
   * from a slice PR merged by hand. A caller installed before it lists
   * `labeled` alone, and `init` moves pins and nothing else, so this is the one
   * place an adopter hears of it. A warning: nothing that worked stops.
   */
  it("warns where the review caller does not listen for a slice PR's merge", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace("types: [closed, labeled]", "types: [labeled]"));

    const { code, out, err } = await check(root, healthy());

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("hand-merged slice PRs");
    expect(out).toContain("types: [closed, labeled]");

    fs.rmSync(path.join(root, ".github", "workflows", "agent-implement-prd.yml"));
    expect((await check(root, healthy())).out).not.toContain("hand-merged slice PRs");
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
   * The PRD chain's cost of skipping the PAT, named where the PAT is (#176).
   * Every slice after the first is started by the advance job re-adding
   * `agent:implement` to the parent, and a label added with `GITHUB_TOKEN`
   * fires nothing — so the chain builds one slice and stops. A clause on the
   * existing error rather than a check of its own: the missing secret is the
   * one fault, and this is one more thing it costs.
   */
  it("says the PRD chain stops after its first slice when AGENT_PAT is missing", async () => {
    const { err } = await check(await installed(), {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(err).toMatch(/PRD chain stops after its first slice/);
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
   * The sixth silent failure, and the one that used to be a private
   * repository's alone: the check-runs API serves a public repository without
   * the scope, so v0.1.0 through v0.1.4 shipped without it and nothing failed
   * until the first private adopter reviewed with no CI evidence at all.
   *
   * That is the story of the **poll**, and it stopped being the story of the
   * **grant** when the loop split into caller and called workflow. The review
   * job declares `checks: read`, so a caller that omits it is refused the
   * elevation before any job starts and never reaches a poll to be served
   * without it — probed on a real token against a public repository (#146,
   * case 1). Hence an error on both, and the public repository is the case
   * worth naming in the title, because it is the one that used to pass.
   */
  it("fails a review caller without checks: read on a public repository too", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^ *checks: read$/m, ""));

    for (const visibility of ["private", "public"] as const) {
      const { code, err } = await check(root, { ...healthy(), visibility });

      expect(code, `${visibility}: exit code`).toBe(1);
      expect(err).toContain("checks: read");
      expect(err).toMatch(/before any job starts/);
    }
  });

  /**
   * The table itself, against the two places the same grants are already
   * written down.
   *
   * `diagnose` rules on a fixed list, and for four releases that list was two
   * rows of the nine the callers actually need: a caller that declared a
   * `permissions:` block and got `pull-requests: write` wrong passed the
   * preflight built to catch exactly that (#45). Which grant a job needs is not
   * a judgement call — the reusable half's own `permissions:` is the ceiling,
   * the authoritative statement of what that job spends, and the reference
   * caller's block is the grant `tests/workflows.test.ts` holds equal to it. So
   * the table is derived from the ceiling here rather than written a third time
   * by hand, and a workflow that grows a scope fails by name in three places
   * instead of drifting in the one copy nothing diffs.
   *
   * Only `dist` ships, so `REQUIRED_PERMISSIONS` has to be a constant in the
   * runner rather than something read out of `examples/callers/` at run time,
   * and a test is the only thing that can hold it to its source — the
   * arrangement `init`'s label table and `docs/ADOPTING.md` §3 are already in.
   */
  const ceilings = (): ReadonlyMap<string, Record<string, string>> => {
    const dir = path.join(PACKAGE_DIR, ".github", "workflows");
    const found = new Map<string, Record<string, string>>();

    for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
      const document = parse(fs.readFileSync(path.join(dir, entry), "utf8")) as {
        readonly on?: { readonly workflow_call?: unknown } | null;
        readonly jobs?: Record<string, { readonly permissions?: Record<string, string> }>;
      } | null;
      // A reusable half is one something can `uses:`, which is the same thing
      // that makes it a workflow somebody's caller hands a token to.
      if (document?.on?.workflow_call === undefined) continue;
      // The widest grant across its jobs, scope by scope, because the caller's
      // grant is the ceiling for all of them. `review.yml` has two jobs, and
      // its `resolve` job holds the `contents: write` the review job narrows
      // back to `read` (#133).
      const RANK: Readonly<Record<string, number>> = { none: 0, read: 1, write: 2 };
      const widest: Record<string, string> = {};
      for (const job of Object.values(document.jobs ?? {})) {
        for (const [scope, level] of Object.entries(job.permissions ?? {})) {
          const held = widest[scope];
          if (held === undefined || (RANK[level] ?? 0) > (RANK[held] ?? 0)) widest[scope] = level;
        }
      }
      found.set(entry.replace(/\.yml$/, ""), widest);
    }
    return found;
  };

  /**
   * Every one of those grants as a scenario: the workflow, the scope and the
   * value. There is no fourth column saying how the absence presents, and its
   * removal is #146's finding rather than a tidy-up.
   *
   * This list used to carry two exceptions to "a missing grant is an error",
   * and each was an argument about a run-time 403: `checks: read`, which a
   * public repository's check-runs API serves without the scope, and
   * `contents: read`, which no call in the follow-ups job spends. Both were
   * arguments about a run that no longer starts. The caller's block is the
   * ceiling for every job it calls, and GitHub refuses an elevation by refusing
   * the *workflow file* — probed on a real token across four scopes, both
   * shapes of shortfall and a caller with no block at all, every one of them a
   * `startup_failure` that reached no step.
   *
   * So the expectation is uniform and needs no table: every cell errors, on
   * either visibility. A scope added to a workflow arrives here as a scenario
   * expecting that, and a row cannot be argued down to a warning without
   * changing `diagnose` itself — which is where the reason now lives.
   */
  const grantCells = (): readonly (readonly [string, string, string, string])[] =>
    [...ceilings()].flatMap(([workflow, grants]) =>
      Object.entries(grants).map(
        ([permission, value]) =>
          [`${workflow}'s ${permission}: ${value}`, workflow, permission, value] as const,
      ),
    );

  it("demands exactly what the reusable halves bound and the reference callers grant", () => {
    const bound = ceilings();
    // The premise: a restructure that stopped finding the reusables would
    // otherwise make every comparison below one between two empty maps.
    expect(bound.size).toBeGreaterThanOrEqual(6);

    const demanded = new Map(
      [...bound.keys()].map((name) => [name, {} as Record<string, string>]),
    );
    for (const row of REQUIRED_PERMISSIONS) {
      for (const name of row.workflows === "all" ? [...bound.keys()] : row.workflows) {
        // Two rows for one cell is one `why` the other silently replaces.
        expect(demanded.get(name)?.[row.permission]).toBeUndefined();
        demanded.set(name, { ...demanded.get(name), [row.permission]: row.value });
      }
    }

    const granted = new Map(
      [...bound.keys()].map((name) => {
        const file = path.join(PACKAGE_DIR, "examples", "callers", `${name}.yml`);
        const [caller] = callersIn(fs.readFileSync(file, "utf8"), manifest.name, file);
        return [name, { ...caller?.permissions }];
      }),
    );

    expect(Object.fromEntries(demanded)).toEqual(Object.fromEntries(bound));
    expect(Object.fromEntries(granted)).toEqual(Object.fromEntries(bound));
  });

  /**
   * And says so about a caller that declares a block and leaves one of them
   * out, which is the shape this command exists for: the scope is missing from
   * a file that looks complete, and what the run gives back is a step failing
   * on `Resource not accessible by integration` — a message that names neither
   * the grant nor the file, on a step whose own name is about labels or about a
   * push.
   *
   * Asserted by exit code as well as by text, because the severity is the
   * check: a row that reports a broken caller and exits 0 is a preflight that
   * says the install is fine.
   *
   * And asserted on **both** visibilities, which is the assertion rather than a
   * parameter — the retired `"private"` class made one of these grants' severity
   * turn on that fact, and nothing in `diagnose` reads it any more.
   *
   * Derived from the same ceilings rather than listed, so a seventh workflow or
   * a scope added to one arrives here as a scenario rather than as a gap.
   */
  it.each(grantCells())(
    "names %s when the caller's own block leaves it out, and fails on it",
    async (_label: string, workflow: string, permission: string, value: string) => {
      const root = await installed();
      edit(root, `agent-${workflow}.yml`, (text) =>
        text.replace(new RegExp(`^ *${permission}: ${value}$`, "m"), ""),
      );

      for (const visibility of ["private", "public"] as const) {
        const { code, out, err } = await check(root, { ...healthy(), visibility });

        // Errors are printed to stderr and exit 1; warnings to stdout and exit
        // 0. Which stream carries the line is therefore the same statement as
        // the code, and both are asserted so a check that moved stream without
        // moving severity cannot pass.
        const said = err.split("\n").find((line) => line.includes(`${permission}: ${value}:`));

        expect(said, `${visibility}: nothing on stderr`).toBeDefined();
        expect(said).toContain(`agent-${workflow}.yml`);
        // And what it says the shortfall costs, which is the correction #146
        // made: the run, before any job starts, rather than the step the scope
        // is spent on.
        expect(said).toMatch(/before any job starts/);
        expect(out, `${visibility}: warned instead`).not.toContain(`${permission}: ${value}:`);
        expect(code, `${visibility}: exit code`).toBe(1);
      }
    },
  );

  /**
   * And says it in a paragraph, not a page. `render` prints a `why` as one
   * unwrapped terminal line and `runDoctor` writes it as one line of
   * `failure_reason.txt`, so length is the difference between a finding a
   * human reads and one they scroll past — and the row that grew to five times
   * its neighbours was the one whose extra sentences needed a correction in
   * three commits running. What each grant's absence does belongs here; the
   * per-repository anatomy of *when* belongs in `docs/ADOPTING.md` §4, where it
   * can be a paragraph with a table next to it.
   *
   * The cap is above every row rather than near the longest, because this is a
   * guard against the next unbounded one, not a style rule.
   */
  it("keeps each reason short enough to read on one line", () => {
    for (const { permission, value, why } of REQUIRED_PERMISSIONS) {
      expect(why.length, `${permission}: ${value} — ${why.slice(0, 60)}…`).toBeLessThan(700);
    }
  });

  /**
   * …and none of them explains the absence as a status code, because a missing
   * caller grant produces no run to return one in. That was the whole of #146:
   * every `why` here was written against the shape before
   * jeffwlawson/winget-manifest-lint#98, where the grant and the job were one
   * file and a short grant cost the call it was spent on — a 403 on a label
   * edit, a 401 at `npx`. The caller's block is the ceiling now, so a row
   * explaining a 403 is a row explaining a step the adopter never reaches, and
   * an adopter who goes looking for that message finds a run with no log in it.
   *
   * The message as well as the code, because that is what those rows actually
   * printed and it names no scope either.
   */
  it("explains no missing grant as a 401 or a 403 on a step", () => {
    for (const { permission, value, why } of REQUIRED_PERMISSIONS) {
      expect(why, `${permission}: ${value}`).not.toMatch(/40[13]/);
      expect(why, `${permission}: ${value}`).not.toContain("Resource not accessible");
    }
  });

  /**
   * …and none of them about a caller that declares no block **anywhere**, which
   * is the one shape the table must not expand over. That job runs with the
   * repository's default `GITHUB_TOKEN`, and the fix is the whole block rather
   * than any scope in it — a job-level block replaces the inherited token, so a
   * list of the scopes it is missing is a list of ways to lose the rest of what
   * it holds.
   */
  it("rules on a caller with no block once rather than once per scope", async () => {
    const { out, err } = await check(adoptedWith([]), healthy());
    const said = `${out}${err}`;

    expect(said.match(/permissions block:/g) ?? []).toHaveLength(1);
    for (const [, , permission, value] of grantCells()) {
      expect(said).not.toContain(`${permission}: ${value}:`);
    }
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

  /**
   * `permissions:` is equally legal at the **workflow top level**, where GitHub
   * applies it to every job — a `uses:` job included — and an adopter who keeps
   * one block above `jobs:` rather than repeating it per job is correctly
   * permissioned. Reading only the job's own block reports every grant missing
   * and offers a fix that changes nothing, which is the wrong-diagnosis class
   * the `write-all` case above exists to prevent, on a shape far more common.
   */
  it("reads permissions declared above jobs: as the grants the job runs with", async () => {
    const root = adoptedWith([
      "permissions:",
      "  checks: read",
      "  contents: write",
      "  packages: read",
      "  pull-requests: write",
      "  statuses: write",
    ]);

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * The upgrade that leaves the review caller's grant behind (#133). A caller
   * installed before the `resolve` job grants `contents: read`, which was every
   * scope the review job itself used — so nothing about the caller looks wrong,
   * and what it costs is the whole workflow: a called job cannot hold more than
   * its caller granted, and GitHub refuses the elevation by failing the run
   * before any job starts. There is no job log to find that in, which is what
   * makes this `doctor`'s to say. The per-cell scenarios above remove the line
   * entirely; this one keeps it at the value that used to be right.
   */
  it("reports a review caller that still grants contents: read", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^( *)contents: write$/m, "$1contents: read"));

    for (const visibility of ["private", "public"] as const) {
      const { code, err } = await check(root, { ...healthy(), visibility });

      expect(code).toBe(1);
      expect(err).toContain("contents: write");
      expect(err).toMatch(/resolveReviewThread/);
      expect(err).toMatch(/before any job starts/);
      // Named as the wrong value it is, rather than as an absent line.
      expect(err).toMatch(/grants the `review` job `contents: read` where it needs/);
      // And **changed**, never added. Followed literally, "add `contents:
      // write`" leaves two `contents:` keys in one block — a workflow GitHub
      // refuses to parse, which is the `startup_failure` with no job log this
      // row exists to warn about rather than to cause.
      expect(err).toMatch(/fix: Change `contents: read` to `contents: write` in that job's/);
      expect(err).not.toMatch(/Add `contents: write`/);
    }
  });

  /**
   * And that is a property of the *row*, not of the one row that needed it
   * first. Every grant a caller can get wrong it can get wrong by value as well
   * as by omission — a scope written `none`, or left at the value an earlier
   * release was right about — and the two want opposite instructions.
   *
   * Derived from the same ceilings as the absence scenarios above, so the next
   * scope to change value arrives here as a case rather than as a gap.
   */
  it.each(grantCells())(
    "tells a caller to change %s rather than add a second key",
    async (_label: string, workflow: string, permission: string, value: string) => {
      const root = await installed();
      edit(root, `agent-${workflow}.yml`, (text) =>
        text.replace(new RegExp(`^( *)${permission}: ${value}$`, "m"), `$1${permission}: none`),
      );

      const { out, err } = await check(root, healthy());
      const said = `${out}${err}`;

      expect(said).toContain(`Change \`${permission}: none\` to \`${permission}: ${value}\``);
      expect(said).not.toContain(`Add \`${permission}: ${value}\``);
    },
  );

  /**
   * The two halves of the fix compose: a value that is wrong in a block the job
   * **inherits** is changed there, and the caveat about a job-level block
   * replacing the top-level one is still what stops an adopter creating one.
   */
  it("points a wrong value in an inherited block at that block", async () => {
    const root = adoptedWith([
      "permissions:",
      "  checks: read",
      "  contents: read",
      "  packages: read",
      "  pull-requests: write",
      "  statuses: write",
    ]);

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toMatch(
      /fix: Change `contents: read` to `contents: write` in the workflow's top-level/,
    );
    expect(err).toMatch(/declares none of its own/);
  });

  /**
   * Which also decides what the *fix* says. A job that inherits and is told to
   * add the grant to its own block would be told to create one — replacing the
   * top-level block and losing every grant it currently holds. A preflight that
   * hands out that instruction is worse than one that said nothing.
   */
  it("points a caller that inherits at the block it actually has", async () => {
    const root = adoptedWith(["permissions:", "  checks: read", "  contents: read"]);

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
    expect(err).toMatch(/top-level `permissions:` block/);
  });

  /**
   * And the other half of the same rule: a job's own block **replaces** the
   * top-level one wholesale rather than merging into it, so a top-level grant
   * the job then narrows past is genuinely gone at run time.
   */
  it("treats a job's own permissions as replacing the top-level block", async () => {
    const root = adoptedWith(
      ["permissions:", "  packages: read", "  pull-requests: write"],
      ["    permissions:", "      checks: read", "      contents: read"],
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
  });

  /**
   * No grant's severity depends on a fact `gh` may not be able to read any
   * more, so an unreadable visibility raises nothing and assumes nothing —
   * where it used to fail `checks: read` on the assumption that the repository
   * was private, and say so. It is failed outright now, which is the same
   * verdict without the caveat (#146).
   */
  it("needs no visibility to rule on a missing grant", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) => text.replace(/^ *checks: read$/m, ""));

    const { code, err } = await check(root, { ...healthy(), visibility: undefined });

    expect(code).toBe(1);
    expect(err).toContain("checks: read");
    expect(err).not.toMatch(/on the assumption/);
  });

  /**
   * The third place a grant can come from is nowhere at all: a job with no
   * `permissions:` block on it and none above `jobs:` runs with the repository's
   * default `GITHUB_TOKEN`, and **both** defaults grant `packages: read` — the
   * restricted one is worded "read repository contents and packages
   * permissions". So the scope rows must not fire here, and above all the fix
   * must not be "add `packages: read` to that job": a job-level block replaces
   * the inherited token rather than adding to it, so following that instruction
   * would drop `pull-requests: write` on a loop that was working.
   */
  it("does not demand packages: read of a caller that inherits the default token", async () => {
    const { err } = await check(adoptedWith([]), healthy());

    expect(err).not.toContain("packages: read");
    expect(err).not.toMatch(/to that job's `permissions:` block/);
  });

  /**
   * What is wrong with that caller is the block, not a scope. Under the
   * restricted default it holds `contents` and `packages` read and nothing
   * else, which is less than every job in this loop declares, so the run is
   * refused before any job starts — the one configuration #146 expected the
   * elevation check to let through, and the probe's third case found it refused
   * like the rest. One finding, and its fix is the whole reference block.
   */
  it("names the absent permissions block, and points at the whole reference block", async () => {
    const { code, err } = await check(adoptedWith([]), healthy());

    expect(code).toBe(1);
    expect(err).toContain("declares no `permissions:` block");
    expect(err).toContain("examples/callers/review.yml");
  });

  it("says nothing about a caller inheriting a permissive default token", async () => {
    const { code, err } = await check(adoptedWith([]), {
      ...healthy(),
      defaultWorkflowPermissions: "write",
    });

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * And an unreadable one is reported rather than ruled on. Since #146 no
   * grant's severity turns on a fact `gh` may fail to answer, so this is the
   * only place an unknown still decides anything — and it errs towards the
   * warning deliberately: failing would be exit 1 on a repository whose default
   * is the permissive one and whose loop works.
   */
  it("reports an inherited token it could not read as something to check", async () => {
    const { code, out } = await check(adoptedWith([]), {
      ...healthy(),
      defaultWorkflowPermissions: undefined,
    });

    expect(code).toBe(0);
    expect(out).toContain("could not be read");
  });

  /**
   * `gh repo view --json visibility` has answered both `PUBLIC` and `public`
   * across releases, so the reader folds the case once rather than listing
   * spellings — and an internal repository is folded in with the private ones,
   * because the check-runs API 403s on it just the same.
   *
   * No diagnosis turns on the answer since #146. What this holds is the shape
   * of a fact rather than a severity: the scenarios above set both spellings
   * and insist the verdict is identical under each, which is an assertion only
   * while the fact can still be set to either.
   */
  it("reads a visibility in whichever case gh answered it", () => {
    expect(["PUBLIC", "public", "Public"].map((raw) => asVisibility(raw))).toEqual([
      "public",
      "public",
      "public",
    ]);
    expect(["PRIVATE", "private", "INTERNAL", "internal"].map((raw) => asVisibility(raw))).toEqual([
      "private",
      "private",
      "private",
      "private",
    ]);
    expect(asVisibility("")).toBeUndefined();
    expect(asVisibility(undefined)).toBeUndefined();
  });

  /**
   * A mistyped `--dir` would otherwise be diagnosed as "no workflow here calls
   * this package, run `init`" — a real finding about a directory that does not
   * exist, with `gh` asked about whatever repository the shell happened to be
   * in. Bad usage, like `init`'s.
   */
  it("refuses a --dir that does not exist rather than diagnosing it", async () => {
    const missing = path.join(os.tmpdir(), "agent-doctor-absent", "typo");

    const { code, err } = await invoke(["doctor", "--dir", missing]);

    expect(code).toBe(2);
    expect(err).toContain(missing);
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
   * And it is the *same* command `init` told them to run, colour and
   * description included. Only the name decides anything at run time, so this
   * breaks no loop — but the two halves of one install path handing out two
   * different definitions of a label is how `docs/ADOPTING.md` §3 stops being
   * true of a repository that did what it was told.
   */
  it("offers the label command init's SETUP.md already listed", async () => {
    const root = await installed();
    const facts = healthy();
    const command =
      STATE_LABELS.filter((label) => label.name === "agent:blocked").map(labelCommand)[0] ?? "";

    const { err } = await check(root, {
      ...facts,
      labels: (facts.labels ?? []).filter((name) => name !== "agent:blocked"),
    });

    expect(command).toContain("--color");
    expect(err).toContain(command);
    expect(fs.readFileSync(path.join(root, "SETUP.md"), "utf8")).toContain(command);
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

  /**
   * Both halves of the name, because a check run named wrongly in either is a
   * check run that does not exist — and the consequence is identical. A
   * `self-check` with no `/` in it is what somebody writes from memory; one
   * naming the wrong called job is what a rename leaves behind. Neither says
   * anything at run time, so a check that read only the first half passed both
   * and left the wait counting its own job among the ones to wait for.
   *
   * The called half is the reusable's job id, which is its filename
   * (`tests/workflows.test.ts`), so the fix can name the whole of it rather
   * than re-emitting whichever wrong half was already there.
   */
  it.each([
    ["names no called job at all", "self-check: review"],
    ["names the wrong called job", "self-check: review / reviewer"],
    // And the whitespace, which is not whitespace: `review.yml` filters with
    // `select(.name != env.SELF_CHECK)`, a byte comparison against the check
    // run's own name, so ` / ` is part of the value rather than spacing around
    // it. `review/review` is what somebody writes from memory and it excludes
    // nothing — the same silence as a wrong job id, reached the other way.
    ["leaves out the spaces around the slash", "self-check: review/review"],
  ])("fails a self-check that %s", async (_case: string, written: string) => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text.replace(/self-check: review \/ review/, written),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("self-check");
    expect(err).toContain("Set `self-check: review / review`");
  });

  /**
   * The calling half is the job's **display name**, which is the id only when
   * the job declares no `name:`. GitHub writes `jobs.<id>.name` into the check
   * run where it has one, and `docs/ADOPTING.md` §4 invites exactly that
   * rename — so composing the id here would fail a correctly-configured caller
   * and hand it a `fix:` that breaks a loop which currently works. The one
   * wrong finding a preflight cannot afford.
   *
   * The findings still name the job by **id**, because that is what an adopter
   * greps their YAML for.
   */
  it("reads the calling job's display name, not its id, as the first half", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text
        .replace(/^  review:$/m, "  review:\n    name: Agent review")
        .replace("self-check: review / review", "self-check: Agent review / review"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /** …and the id-shaped one is now the wrong answer on that same caller. */
  it("fails a named job whose self-check still states the job id", async () => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text.replace(/^  review:$/m, "  review:\n    name: Agent review"),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("Set `self-check: Agent review / review`");
    // Named by id, since that is what they will search their YAML for.
    expect(err).toContain("`review` job");
  });

  /**
   * The secret being *set* and the job being *handed* it are two facts, and
   * only the first is a repository setting. A `workflow_call` job receives what
   * its caller passes and nothing else, `AGENT_PAT` is optional on the other
   * side, and the `secrets.AGENT_PAT || secrets.GITHUB_TOKEN` fallback absorbs
   * the empty string it arrives as — so a caller an adopter rewrote without the
   * line runs the loop under the built-in token with the secret correctly set.
   * That is `docs/ADOPTING.md` §1's failures two, three and four, reached from
   * the one place nothing else here looks.
   */
  it("fails a caller that does not pass AGENT_PAT to the workflow it calls", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^ *AGENT_PAT: .*$/m, ""),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("AGENT_PAT");
    expect(err).toContain("agent-fix.yml");
    expect(err).toContain("secrets: inherit");
  });

  /**
   * …and the caller that is *supposed* to hand over nothing (#50).
   *
   * `follow-ups.yml` declares no secrets at all: it runs no model, so there is
   * no `CLAUDE_CODE_OAUTH_TOKEN` to take, and it creates its issues with the
   * workflow token, so there is no `AGENT_PAT` either. The generic wiring check
   * above reads a caller's `secrets:` block and not the workflow behind it, so
   * without a fixed-list exemption it reports the reference caller this package
   * ships — and its `fix:` would have an adopter add a secret GitHub refuses to
   * pass to a workflow that does not declare it. A preflight whose advice breaks
   * a working loop is worse than no preflight.
   *
   * Run against the caller `init` really wrote rather than a fixture, so this is
   * the file an adopter would be handed the advice about. That it declares no
   * `secrets:` block at all is the other half of the pair, and is asserted where
   * the workflow shapes are — `tests/workflows.test.ts`, on both halves at once.
   */
  it("asks for no AGENT_PAT wire on the caller whose workflow takes no secrets", async () => {
    const root = await installed();

    const { code, out, err } = await check(root, healthy());

    expect(`${out}${err}`).not.toContain("agent-follow-ups.yml");
    expect(code).toBe(0);
  });

  /**
   * `secrets: inherit` hands over every secret the repository holds, which is
   * what the reference callers decline to do — but it does hand over this one,
   * so it is a wire rather than a fault. Reporting it would be a preflight
   * arguing with a choice.
   */
  it("accepts a caller that inherits every secret", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) =>
      text.replace(/^    secrets:\n(?:      .*\n)+/m, "    secrets: inherit\n"),
    );

    const { code, err } = await check(root, healthy());

    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * And where the secret is not set either, the missing wire is the next thing
   * to do rather than a second fault: one error about the secret, and this
   * reported as something to know. Two errors for one cause is how a list of
   * real findings stops being read.
   */
  it("reports the missing wire as a warning when the secret is not set either", async () => {
    const root = await installed();
    edit(root, "agent-fix.yml", (text) => text.replace(/^ *AGENT_PAT: .*$/m, ""));

    const { out, err } = await check(root, {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(out).toContain("secrets wiring");
    expect(err).not.toContain("secrets wiring");
  });

  /**
   * The automatic fix, switched on and unable to fire (#102). `auto-fix: true`
   * asks the review to add `agent:fix` itself, and a label added with
   * `GITHUB_TOKEN` fires no event, so without the PAT no automatic round ever
   * starts. Deprecated since the fix-round budget (#201), and still honoured
   * for a release, so still worth the row.
   *
   * A warning, not an error: the loop still works and a human adding the label
   * by hand loses only the automation.
   *
   * The gesture is the one an adopter who kept the input has made: the line
   * added to the reference caller's `with:` block.
   */
  const withAutoFix = async (): Promise<string> => {
    const root = await installed();
    edit(root, "agent-review.yml", (text) =>
      text.replace("self-check: review / review", "self-check: review / review\n      auto-fix: true"),
    );
    return root;
  };

  it("warns when the automatic fix is on and no PAT can make it fire", async () => {
    const { code, out, err } = await check(await withAutoFix(), {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(out).toContain("auto-fix");
    expect(out).toMatch(/fires no event/);
    // The row above is the error for the same missing secret; this one must not
    // add a second exit code to it.
    expect(err).not.toContain("auto-fix without a PAT");
    expect(code).toBe(1);
  });

  /**
   * And no marker label to demand: the rounds spent are counted from the pull
   * request's own verdicts (#201), so a healthy repository with the input on
   * passes clean without `agent:auto-fixed`.
   */
  it("says nothing about the automatic fix when the PAT is there", async () => {
    const { code, out, err } = await check(await withAutoFix(), healthy());

    expect(err).toBe("");
    expect(out).not.toContain("auto-fix");
    expect(code).toBe(0);
  });

  /**
   * And nothing on a repository that left the input alone, which is every
   * repository `init` has just finished with: the reference caller ships it
   * commented out.
   */
  it("says nothing about the automatic fix on a caller that did not turn it on", async () => {
    const { out } = await check(await installed(), {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(out).not.toContain("auto-fix");
  });

  /**
   * **Unreadable stays unreadable.** Secrets are readable only to an admin, and
   * "nobody could ask" is not "the PAT is missing" — a warning here would tell
   * every non-admin their automatic fix is broken. The unreadable-secrets
   * warning below is the honest answer, and it is already there.
   */
  it("does not claim the automatic fix is broken when the secrets could not be read", async () => {
    const { code, out } = await check(await withAutoFix(), { ...healthy(), secrets: undefined });

    expect(out).not.toContain("auto-fix");
    expect(out).toMatch(/could not read the actions secrets/i);
    expect(code).toBe(0);
  });

  /**
   * GitHub keeps repository secrets and the organization secrets shared with a
   * repository at two endpoints, and an organization holding one Claude token
   * and one bot PAT centrally answers the first with nothing. Reading only that
   * one is two errors and exit 1 on a working loop, with a fix telling them to
   * duplicate an organization secret.
   *
   * The judgement is the third argument: `safeGh` renders the organization
   * endpoint's refusal of a user-owned repository (422 against this repository's
   * `gh`) and a 403 on an organization's as the same empty string, so knowing
   * there is no organization is what lets the first be read as "there are none"
   * rather than collapsing every org-less repository into unknown.
   */
  it("counts an organization's shared secrets as set, without collapsing repos that have none", () => {
    expect(availableSecrets([], ["AGENT_PAT"], true)).toEqual(["AGENT_PAT"]);
    expect(availableSecrets(["CLAUDE_CODE_OAUTH_TOKEN"], [], true)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    // No organization to ask about: the absent list is the answer, not a silence.
    expect(availableSecrets([], undefined, false)).toEqual([]);
    // One that has an organization, whose list could not be read: absence
    // cannot be concluded from a list nobody was served.
    expect(availableSecrets([], undefined, true)).toBeUndefined();
    expect(availableSecrets([], undefined, undefined)).toBeUndefined();
    expect(availableSecrets(undefined, ["AGENT_PAT"], false)).toBeUndefined();
  });

  /** A fact `gh` could not answer is reported as unknown, never as a pass. */
  it("says what it could not read rather than treating it as fine", async () => {
    const { code, out } = await check(await installed(), {
      secrets: undefined,
      canCreatePullRequests: undefined,
      defaultWorkflowPermissions: undefined,
      labels: undefined,
      visibility: undefined,
      releases: undefined,
      actionsPolicies: undefined,
    });

    expect(code).toBe(0);
    expect(out).toMatch(/could not/i);
  });

  /**
   * …and the last line a human's eye lands on has to say the same thing. With
   * no `gh`, no auth or no admin, the only thing checked was the callers, and
   * "nothing broken" is then a claim about a repository nothing was read from —
   * at exactly the moment `setup/SETUP.md` §5 sends somebody here, and
   * permanently for an adopter who is not an admin. Exit 0 is still right:
   * nothing was found to be wrong.
   */
  it("does not say nothing is broken when no repository fact was read", async () => {
    const { code, out } = await check(await installed(), {
      secrets: undefined,
      canCreatePullRequests: undefined,
      defaultWorkflowPermissions: undefined,
      labels: undefined,
      visibility: undefined,
      releases: undefined,
      actionsPolicies: undefined,
    });

    expect(code).toBe(0);
    expect(out).not.toContain("nothing broken");
    expect(out).toContain("No repository fact could be read");

    // And it is still said where something *was* read, so the sentence stays
    // the one a working run ends on.
    const known = await check(await installed(), healthy());
    expect(known.out).toContain("nothing broken");
  });

  /**
   * The other side of that, and the one the shape of `gh`'s output decides: a
   * repository with **no** secrets is a fact, not a silence, and it is the state
   * a repository is in at exactly the moment `SETUP.md` §5 says to run this.
   * Asked for as lines, `[]` and "could not read" are both empty output and the
   * first run would pass on the first day. So the query asks for a JSON array,
   * and only a `gh` that answered nothing at all is unknown.
   */
  it("reads an empty list as empty rather than as unreadable", async () => {
    expect(parseList('["AGENT_PAT"]')).toEqual(["AGENT_PAT"]);
    expect(parseList("[]")).toEqual([]);
    expect(parseList("")).toBeUndefined();

    const fresh = await check(await installed(), { ...healthy(), secrets: [], labels: [] });

    expect(fresh.code).toBe(1);
    expect(fresh.err).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(fresh.err).toContain("AGENT_PAT");
    expect(fresh.err).toContain("agent:implement");
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
