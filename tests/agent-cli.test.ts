import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { COMMANDS, run, type CliIo } from "../cli.js";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";
import { copyAssets } from "../scripts/copy-assets.js";
import { callersIn, readInstalledCallers, REFERENCE_CALLER_FILES } from "../setup/callers.js";
import {
  ADVISORY_LABELS,
  advisoryLabelSpecsFor,
  APP_CHANGE,
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
  availableVariable,
  DEFAULT_FIX_ROUNDS,
  diagnose,
  FIX_ROUNDS_VARIABLE,
  TIMEOUT_VARIABLES,
  parseList,
  REQUIRED_PERMISSIONS,
  runDoctor,
  type Finding,
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
import type { LabelSurface, RepoLabel } from "../setup/labels.js";
import type { AppManifest, AppSurface, RegisteredApp, RepoOwner, SecretPlacement } from "../setup/app.js";

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
 * The App step, for the tests that are not about it: a repository whose
 * secrets could not be listed, which it reports and leaves alone, and a write
 * that fails the test rather than reaching anything.
 */
const noApp: AppSurface = {
  secrets: () => undefined,
  owner: () => undefined,
  orgAdmin: () => undefined,
  register: () => {
    throw new Error("init created an App in a test that is not about it");
  },
  setSecret: () => {
    throw new Error("init stored a secret in a test that is not about it");
  },
  openInstall: () => {
    throw new Error("init opened an install page in a test that is not about it");
  },
  ask: () => {
    throw new Error("init asked a question in a test that is not about it");
  },
};

/**
 * The label step, for the tests that are not about it: a repository whose
 * labels could not be listed, which it reports and leaves alone, and a write
 * that fails the test rather than reaching anything.
 */
const noLabels: LabelSurface = {
  labels: () => undefined,
  carriers: () => undefined,
  create: () => {
    throw new Error("init created a label in a test that is not about it");
  },
  edit: () => {
    throw new Error("init edited a label in a test that is not about it");
  },
  remove: () => {
    throw new Error("init deleted a label in a test that is not about it");
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
const replayed = async <T>(
  scenario: { visibility?: string; policies?: readonly object[]; unreadable?: readonly number[] },
  body: () => T | Promise<T>,
): Promise<{ result: T; writes: unknown[][] }> => {
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
    const result = await body();
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
 * Where one caller's job sits in a caller file's text: from its `  <id>:` line
 * to the next job's, the comments above that next job included. A caller file
 * holds several callers (#225), so a scenario that breaks or removes one has to
 * reach that job and no other.
 */
const jobSpan = (text: string, job: string): { readonly from: number; readonly to: number } | undefined => {
  const from = text.search(new RegExp(`^  ${job}:$`, "m"));
  if (from === -1) return undefined;
  const next = text.slice(from + 1).search(/^(  #.*\n)*  [\w-]+:$/m);
  return { from, to: next === -1 ? text.length : from + 1 + next };
};

/** A caller file's text with one caller's job taken out. */
const withoutJob = (text: string, job: string): string => {
  const span = jobSpan(text, job);
  expect(span, `no \`${job}\` job to remove`).toBeDefined();
  return `${text.slice(0, span?.from ?? 0)}${text.slice(span?.to ?? 0)}`;
};

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

/**
 * The six-file layout, as `init` wrote it before #225: one caller file per
 * caller, `agent-<job>.yml`, each the reference caller file's trigger and that
 * caller's job alone, under its own grants rather than a top-level
 * `permissions: {}`, pinned to `ref`. Written into `root`; returns each file
 * and the text it was given.
 */
const sixFileTree = (root: string, ref: string): readonly { readonly file: string; readonly text: string }[] =>
  ["issue", "pr"].flatMap((name) => {
    const reference = fs.readFileSync(path.join("examples", "callers", `${name}.yml`), "utf8");
    const jobs = callersIn(reference, manifest.name, `${name}.yml`).map((c) => c.jobId);
    return jobs.map((job) => {
      const text = jobs
        .filter((other) => other !== job)
        .reduce(withoutJob, reference)
        .replace(/^permissions: \{\}\n/m, "")
        .replaceAll(`@v${manifest.version}`, `@${ref}`);
      const file = `.github/workflows/agent-${job}.yml`;
      fs.writeFileSync(path.join(root, ...file.split("/")), text);
      return { file, text };
    });
  });

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

  /** The reference caller files, one per side (#225): `issue` and `pr`. */
  const referenceNames = fs
    .readdirSync(path.join("examples", "callers"))
    .filter((entry) => entry.endsWith(".yml"))
    .map((entry) => entry.replace(/\.yml$/, ""))
    .sort();

  /** The workflows each of them calls, read the way `init` reads them. */
  const referenceCallers = (name: string) =>
    callersIn(read(".", `examples/callers/${name}.yml`), manifest.name, `${name}.yml`);
  const referenceWorkflows = referenceNames.flatMap((name) => referenceCallers(name).map((c) => c.workflow));

  it("writes one caller file per reference file, pinned to this package's own version", async () => {
    const root = adopted();

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(referenceNames).toEqual(["issue", "pr"]);
    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => c.action)).toEqual(
      referenceNames.map(() => "created"),
    );
    for (const name of referenceNames) {
      const text = read(root, `.github/workflows/agent-${name}.yml`);
      for (const { workflow } of referenceCallers(name)) {
        expect(text).toContain(`/.github/workflows/${workflow}.yml@v${manifest.version}`);
      }
      expect(text).toContain("packages: read");
    }
    expect(fs.readdirSync(path.join(root, ".github", "workflows")).sort()).toEqual(["agent-issue.yml", "agent-pr.yml"]);
  });

  /**
   * An adopter on the six-file layout has every caller already, so a re-run
   * moves each file's pin and writes nothing else. A merged file beside the
   * six would call every reusable twice: two runs of each per label, racing
   * each other for the same branch (#225).
   */
  it("moves only the pins on a six-file tree, and writes no merged file beside it", async () => {
    const root = adopted();
    const six = sixFileTree(root, "v0.0.1");
    expect(six).toHaveLength(6);

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(fs.readdirSync(path.join(root, ".github", "workflows")).sort()).toEqual(
      six.map(({ file }) => path.basename(file)).sort(),
    );
    for (const { file, text } of six) {
      expect(read(root, file)).toBe(text.replace("@v0.0.1", `@v${manifest.version}`));
    }
    expect(changes.filter((c) => c.file.endsWith(".yml")).map((c) => `${c.file} ${c.action}`).sort()).toEqual(
      six.map(({ file }) => `${file} updated`).sort(),
    );
  });

  /**
   * `self-check` is `<caller job id> / <called job id>` and is the one coupling
   * in a caller with no runtime symptom, so nothing is written without it
   * naming the job it sits in — `assertCoupled` reads the result back rather
   * than trusting that a rewrite was applied.
   */
  it("writes a self-check naming the job it sits in", async () => {
    const root = adopted();

    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(read(root, ".github/workflows/agent-pr.yml")).toMatch(
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
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    const theirs = read(root, ".github/workflows/agent-pr.yml")
      .replace(/^  review:$/m, "  agent_review:")
      .replace(/self-check: review \/ review/, "self-check: agent_review / review")
      .replace(/^(    with:)$/m, "$1\n      default-branch: trunk\n      node-version-file: .tool-versions\n      setup: pnpm i --frozen-lockfile")
      .replace(/^      pull-requests: write$/m, "      pull-requests: write\n      id-token: write")
      .replaceAll(`@v${manifest.version}`, "@v0.0.1");
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-pr.yml"), theirs);

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    const text = read(root, ".github/workflows/agent-pr.yml");
    expect(text).toBe(theirs.replaceAll("@v0.0.1", `@v${manifest.version}`));
    // Named as well as compared, so an edit above that silently matched
    // nothing cannot leave this asserting that two identical files are equal.
    expect(text).toContain("setup: pnpm i --frozen-lockfile");
    expect(text).toContain("default-branch: trunk");
    expect(text).toContain("id-token: write");
    expect(text).toMatch(/^  agent_review:$/m);
    expect(changes.find((c) => c.file.endsWith("agent-pr.yml"))?.action).toBe("updated");
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
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    const pr = path.join(root, ".github", "workflows", "agent-pr.yml");
    const declined = withoutJob(fs.readFileSync(pr, "utf8"), "update-branch");
    fs.writeFileSync(pr, declined);

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(fs.readFileSync(pr, "utf8")).toBe(declined);
    const kept = changes.filter((c) => c.action === "kept" && c.file.endsWith(".yml"));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.note ?? "").toContain("`update-branch`");
    expect(kept[0]?.note ?? "").toContain("examples/callers/pr.yml");
  });

  /** …and the same for a whole side declined, which is a caller file never copied. */
  it("does not put back a caller file the adopter deleted, and says it did not", async () => {
    const root = adopted();
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    fs.rmSync(path.join(root, ".github", "workflows", "agent-issue.yml"));

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(fs.existsSync(path.join(root, ".github", "workflows", "agent-issue.yml"))).toBe(false);
    const change = changes.find((c) => c.file.endsWith("agent-issue.yml"));
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toContain("`implement`, `implement-prd`");
    expect(change?.note ?? "").toContain("examples/callers/issue.yml");
  });

  /**
   * The filename is ours by convention only. A workflow of an adopter's own
   * that happens to be called `agent-pr.yml` is a file this never wrote, and
   * overwriting it is the same act the re-run above refuses — with worse
   * consequences, since nothing in it was ever a caller.
   */
  it("refuses to write over a file of the same name that is not a caller", async () => {
    const root = adopted();
    const theirs = "name: Our own PR job\non: workflow_dispatch\njobs:\n  fix:\n    runs-on: ubuntu-latest\n";
    fs.writeFileSync(path.join(root, ".github", "workflows", "agent-pr.yml"), theirs);

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(read(root, ".github/workflows/agent-pr.yml")).toBe(theirs);
    expect(changes.find((c) => c.file.endsWith("agent-pr.yml"))?.action).toBe("kept");
  });

  it("reports an unchanged caller rather than rewriting it", async () => {
    const root = adopted();
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

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

    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    const setup = read(root, "SETUP.md");
    expect(setup).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(setup).toContain("AGENT_PAT");
    expect(setup).toContain("agent:blocked");
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

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

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

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(read(root, "SETUP.md")).toBe("# How we set this repo up\n");
    const change = changes.find((c) => c.file === "SETUP.md");
    expect(change?.action).toBe("kept");
    expect(change?.note ?? "").toMatch(/not written by/i);
  });

  it("is reachable as a subcommand and takes a directory", async () => {
    const root = adopted();

    const { code, out } = await invoke(["init", "--dir", root]);

    expect(code).toBe(0);
    expect(out).toContain("agent-issue.yml");
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
    expect(calls).toEqual([
      "GH_REPO= repo view --json visibility --jq .visibility",
      "GH_REPO= label list --limit 1000 --json name,color,description",
      // The App step: with no secret list to read, nothing says the loop has
      // no App, so it creates none and asks nothing more.
      "GH_REPO= repo view --json owner,isInOrganization --jq [.owner.login, .isInOrganization] | @json",
      "GH_REPO= api repos/{owner}/{repo}/actions/secrets?per_page=100 --jq [.secrets[].name] | @json",
    ]);
  });

  it("refuses a flag it does not know rather than ignoring it", async () => {
    const { code, err } = await invoke(["init", "--force"]);

    expect(code).toBe(2);
    expect(err).toContain("--force");
  });

  /**
   * `--app` is `init`'s alone (#322). Against a `gh` that answers nothing, it
   * gets as far as asking who owns the repository, and stops there rather
   * than starting a flow it cannot finish.
   */
  it.skipIf(process.platform === "win32")("takes --app, which doctor refuses", async () => {
    const root = adopted();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fake-gh-"));
    roots.push(bin);
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const saved = process.env["PATH"];
    process.env["PATH"] = `${bin}${path.delimiter}${saved ?? ""}`;
    try {
      const { code, out } = await invoke(["init", "--dir", root, "--app"]);

      expect(code).toBe(0);
      expect(out).toMatch(/kept\s+GitHub App \(could not read which account owns this repository/);
    } finally {
      if (saved === undefined) delete process.env["PATH"];
      else process.env["PATH"] = saved;
    }

    const { code, err } = await invoke(["doctor", "--dir", root, "--app"]);
    expect(code).toBe(2);
    expect(err).toContain("--app");
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

    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

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
    expect(mandated).toHaveLength(5);
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
    const demanded = new Set(labelSpecsFor(referenceWorkflows).map((label) => label.name));

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

    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    expect(byName(advisoryLabelSpecsFor(referenceWorkflows))).toEqual(byName(conditional));
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
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    const pr = path.join(root, ".github", "workflows", "agent-pr.yml");
    fs.writeFileSync(pr, withoutJob(fs.readFileSync(pr, "utf8"), "follow-ups"));
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });

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

  /** The PR-side caller file: the one file `init` installs that runs on the trigger (#225). */
  const triggered = [".github/workflows/agent-pr.yml"];

  it("creates the policy for the callers alone, and a second run reports it unchanged", async () => {
    const root = adopted();
    const { surface, sent } = github("public", []);

    const first = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

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

    const second = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

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
    await init({ dir: root, app: noApp, github: github("private", []).surface, labels: noLabels });
    const review = path.join(root, ".github", "workflows", "agent-pr.yml");
    fs.writeFileSync(review, fs.readFileSync(review, "utf8").replace(/^on:$/m, "on:\n  workflow_dispatch:"));
    const { surface, sent } = github("public", []);

    await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(sent[0]?.body.rules[0].parameters.allowed_events).toEqual(["pull_request_target", "workflow_dispatch"]);
  });

  it("extends its own policy in place when a caller file has been added since", async () => {
    const root = adopted();
    // The `review` caller in a file of its own, and the rest of the PR side in
    // the file `init` installs, with the policy covering only the first.
    await init({ dir: root, app: noApp, github: github("private", []).surface, labels: noLabels });
    const dir = path.join(root, ".github", "workflows");
    const pr = fs.readFileSync(path.join(dir, "agent-pr.yml"), "utf8");
    fs.writeFileSync(path.join(dir, "agent-pr.yml"), withoutJob(pr, "review"));
    fs.writeFileSync(
      path.join(dir, "agent-review.yml"),
      ["fix", "update-branch", "follow-ups"].reduce(withoutJob, pr),
    );
    const earlier = ".github/workflows/agent-review.yml";
    const { surface, sent } = github("public", [
      { id: 3, name: POLICY_NAME, enforcement: "active", include: [earlier], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("updated");
    expect(sent.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "PUT", id: 3 }]);
    expect(sent[0]?.body.conditions.workflow_path.include).toEqual([...triggered, earlier].sort());
  });

  /**
   * The policy follows the files, not the names it was written for (#225): an
   * adopter who merges the six-file layout by hand leaves its old PR-side
   * files gone, and a policy still naming them would allow the trigger for
   * whatever workflow is next given one of those names.
   */
  it("drops the files that no longer hold a PR-side caller when the callers are merged by hand", async () => {
    const root = adopted();
    sixFileTree(root, `v${manifest.version}`);
    const six = ["review", "fix", "update-branch", "follow-ups"].map((job) => `.github/workflows/agent-${job}.yml`);
    const { surface, sent } = github("public", []);
    await init({ dir: root, app: noApp, github: surface, labels: noLabels });
    expect(sent[0]?.body.conditions.workflow_path.include).toEqual([...six].sort());

    // Merged by hand: the reference PR-side file in, the four it replaces out.
    const dir = path.join(root, ".github", "workflows");
    for (const file of six) fs.rmSync(path.join(root, ...file.split("/")));
    fs.copyFileSync(path.join("examples", "callers", "pr.yml"), path.join(dir, "agent-pr.yml"));

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("updated");
    expect(policy?.note).toContain(".github/workflows/agent-review.yml");
    expect(sent.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "POST" }, { method: "PUT", id: 7 }]);
    expect(sent[1]?.body.conditions.workflow_path.include).toEqual(triggered);

    const again = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(again.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(2);
  });

  /**
   * Merged into a file the policy already names, so every caller is allowed
   * and nothing is short: the names left over are still dropped.
   */
  it("drops a file that no longer holds a caller even when every caller is already allowed", async () => {
    const root = adopted();
    const gone = ".github/workflows/agent-review.yml";
    const { surface, sent } = github("public", [
      { id: 3, name: POLICY_NAME, enforcement: "active", include: [...triggered, gone], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("updated");
    expect(sent.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "PUT", id: 3 }]);
    expect(sent[0]?.body.conditions.workflow_path.include).toEqual(triggered);
  });

  /**
   * An adopter may add a workflow of their own to this policy. What decides an
   * entry is stale is whether any workflow file still runs on the trigger
   * there, never whether it holds a caller: a routine re-run that dropped
   * theirs would block it on a public repository, behind their back. Each way
   * an entry can name one of theirs (#330 review): by path, by glob, and a file
   * this cannot parse, whose trigger is unknown rather than absent.
   */
  it.each([
    ["by path", ".github/workflows/deploy-preview.yml", "on:\n  pull_request_target:\n    types: [opened]\njobs: {}\n"],
    ["by glob", ".github/workflows/deploy-*.yml", "on: [push, pull_request_target]\njobs: {}\n"],
    ["unparseable", ".github/workflows/deploy-preview.yml", "on: [pull_request_target\n  : : :\n"],
  ])("keeps an adopter's own workflow on the trigger in its policy, named %s", async (_how, entry, text) => {
    const root = adopted();
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    fs.writeFileSync(path.join(root, ".github", "workflows", "deploy-preview.yml"), text);
    const include = [...triggered, entry].sort();
    const { surface, sent } = github("public", [
      { id: 3, name: POLICY_NAME, enforcement: "active", include, exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  /** …and drops one that is still there but no longer runs on the trigger, keeping the rest. */
  it("drops an adopter's own workflow that no longer runs on the trigger", async () => {
    const root = adopted();
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    const dir = path.join(root, ".github", "workflows");
    fs.writeFileSync(path.join(dir, "deploy-preview.yml"), "on: push\njobs: {}\n");
    fs.writeFileSync(path.join(dir, "label-preview.yml"), "on:\n  pull_request_target:\njobs: {}\n");
    const dropped = ".github/workflows/deploy-preview.yml";
    const kept = ".github/workflows/label-preview.yml";
    const { surface, sent } = github("public", [
      { id: 3, name: POLICY_NAME, enforcement: "active", include: [...triggered, dropped, kept], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("updated");
    expect(policy?.note).toContain(`no longer for ${dropped}`);
    expect(sent.map(({ method, id }) => ({ method, id }))).toEqual([{ method: "PUT", id: 3 }]);
    expect(sent[0]?.body.conditions.workflow_path.include).toEqual([...triggered, kept].sort());
  });

  /**
   * A policy somebody else wrote is theirs: what it names is not this step's
   * to prune, even where a file it names holds no caller.
   */
  it("leaves the file list of a policy it did not write alone", async () => {
    const root = adopted();
    const { surface, sent } = github("public", [
      { id: 9, name: "theirs", enforcement: "active", include: [...triggered, ".github/workflows/agent-review.yml"], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("counts a policy somebody else wrote, if it allows the trigger for every caller", async () => {
    const root = adopted();
    const { surface, sent } = github("public", [
      { id: 9, name: "theirs", enforcement: "active", include: [".github/workflows/agent-*.yml"], exclude: [], allowedEvents: ["pull_request_target"] },
    ]);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    expect(changes.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(sent).toHaveLength(0);
  });

  it("says nothing and writes nothing on a private repository", async () => {
    const root = adopted();
    const { surface, sent } = github("private", []);

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

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

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("kept");
    expect(policy?.note).toContain("HTTP 403");
    expect(policy?.note).toContain("gh api --method POST repos/{owner}/{repo}/actions/policies --input -");
    expect(policy?.note).toContain('"workflow_path":{"include":[".github/workflows/agent-pr.yml"]');
    expect(policy?.note).toContain("Settings → Actions → Policies");
    expect(changes.filter((c) => c.file.endsWith(".yml")).every((c) => c.action === "created")).toBe(true);
  });

  /**
   * Against the replay, whose list omits what each policy says (#238): a
   * second run reads the policy the first one created from its own endpoint,
   * finds it allows every caller, and writes nothing.
   */
  it.skipIf(process.platform === "win32")("reads each policy in full, so a re-run leaves its own alone", async () => {
    const root = adopted();

    const first = await replayed({ visibility: "PUBLIC" }, () => init({ dir: root, app: noApp, github: livePolicySurface(root), labels: noLabels }));

    expect(first.result.find((c) => c.file === POLICY_CHANGE)?.action).toBe("created");
    expect(first.writes.map((call) => call.slice(0, 3))).toEqual([["api", "--method", "POST"]]);
    const created = { id: 6133, target: "actions", source_type: "Repository", source: "repo", ...(first.writes[0]?.[4] as object) };

    const second = await replayed({ visibility: "PUBLIC", policies: [created] }, () =>
      init({ dir: root, app: noApp, github: livePolicySurface(root), labels: noLabels }),
    );

    expect(second.result.find((c) => c.file === POLICY_CHANGE)?.action).toBe("unchanged");
    expect(second.writes).toEqual([]);
  });

  /**
   * A policy whose detail could not be read may be the very one that allows
   * the callers, or this step's own: creating a second beside it, or calling
   * the repository uncovered, would both be verdicts on a fact nobody read.
   */
  it.skipIf(process.platform === "win32")("leaves the policy to a human where one could not be read", async () => {
    const root = adopted();
    const theirs = { id: 4, name: "theirs", enforcement: "active" };

    const { result, writes } = await replayed({ visibility: "PUBLIC", policies: [theirs], unreadable: [4] }, () =>
      init({ dir: root, app: noApp, github: livePolicySurface(root), labels: noLabels }),
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

    const changes = await init({ dir: root, app: noApp, github: surface, labels: noLabels });

    const policy = changes.find((c) => c.file === POLICY_CHANGE);
    expect(policy?.action).toBe("kept");
    expect(policy?.note).toContain("gh api --method POST");
    expect(sent).toHaveLength(0);
  });
});

/**
 * The loop's GitHub App (#322). `init` creates it through the manifest flow
 * where nothing says not to, and stores its ID and key where one setup covers
 * the most without assuming an access it was not shown. Against a stand-in
 * surface that records every write; the live flow is `tests/app.test.ts`'s.
 */
describe("init creates the loop's GitHub App", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const adopted = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-init-app-"));
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    roots.push(root);
    return root;
  };

  const registered: RegisteredApp = {
    id: 4242,
    slug: "acme-loop-bot",
    name: "Acme Loop Bot",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n",
  };

  const app = (scenario: {
    secrets: readonly string[] | undefined;
    owner?: RepoOwner | undefined;
    admin?: boolean | undefined;
    /** What the person types, or `undefined` for no TTY to ask on. */
    answer?: string | undefined;
  }) => {
    const manifests: AppManifest[] = [];
    const stored: { name: string; value: string; placement: SecretPlacement }[] = [];
    const asked: string[] = [];
    const opened: string[] = [];
    const questions: string[] = [];
    const surface: AppSurface = {
      secrets: () => scenario.secrets,
      owner: () => ("owner" in scenario ? scenario.owner : { login: "acme", organization: true }),
      orgAdmin: (org) => {
        asked.push(org);
        return scenario.admin;
      },
      register: async (_owner, manifest) => {
        manifests.push(manifest);
        return registered;
      },
      setSecret: (name, value, placement) => {
        stored.push({ name, value, placement });
        return undefined;
      },
      openInstall: (url) => {
        opened.push(url);
      },
      ask: async (question) => {
        questions.push(question);
        return scenario.answer;
      },
    };
    return { surface, manifests, stored, asked, opened, questions };
  };

  const run = (surface: AppSurface, createApp?: boolean) =>
    init({
      dir: adopted(),
      github: offline,
      labels: noLabels,
      app: surface,
      ...(createApp === undefined ? {} : { createApp }),
    });

  it.each([false, true])("reports an App whose secrets are set, and changes nothing (--app: %s)", async (createApp) => {
    const { surface, manifests, stored, opened } = app({ secrets: ["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY", "AGENT_PAT"] });

    const changes = await run(surface, createApp);

    const change = changes.find((c) => c.file === APP_CHANGE);
    expect(change?.action).toBe("unchanged");
    expect(change?.note).toContain("AGENT_APP_ID and AGENT_APP_PRIVATE_KEY are set");
    expect([manifests, stored, opened]).toEqual([[], [], []]);
  });

  it("creates the App where there is neither an App nor AGENT_PAT, and takes its name from GitHub", async () => {
    const { surface, manifests, stored, opened } = app({ secrets: [], admin: true });

    const changes = await run(surface);

    expect(manifests).toEqual([
      {
        name: "acme-agent-loop",
        url: `https://github.com/${manifest.name.replace(/^@/, "")}`,
        public: false,
        default_permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          workflows: "write",
          metadata: "read",
        },
        default_events: [],
      },
    ]);
    expect(manifests[0]).not.toHaveProperty("hook_attributes");
    expect(changes.find((c) => c.file.startsWith(APP_CHANGE))).toEqual({
      file: `${APP_CHANGE} "Acme Loop Bot"`,
      action: "created",
      note: "ID 4242; install it on the repositories it may act on at https://github.com/apps/acme-loop-bot/installations/new",
    });
    expect(stored.map(({ name, value }) => [name, value])).toEqual([
      ["AGENT_APP_ID", "4242"],
      ["AGENT_APP_PRIVATE_KEY", registered.pem],
    ]);
    expect(opened).toEqual(["https://github.com/apps/acme-loop-bot/installations/new"]);
    // The key is stored, never shown.
    expect(JSON.stringify(changes)).not.toContain("PRIVATE KEY-----");
  });

  /**
   * An existing adopter on `AGENT_PAT` is offered the App, never put on it
   * (#323). Without a TTY there is nobody to answer, so the PAT stays and the
   * switch is named rather than waited for.
   */
  it("keeps AGENT_PAT without a TTY, and names the switch", async () => {
    const { surface, manifests, stored, questions } = app({ secrets: ["AGENT_PAT"], answer: undefined });

    const changes = await run(surface);

    const change = changes.find((c) => c.file === APP_CHANGE);
    expect(change?.action).toBe("kept");
    expect(change?.note).toContain("init --app");
    expect(questions).toHaveLength(1);
    expect([manifests, stored]).toEqual([[], []]);
  });

  /** The question defaults to no: Enter, or anything short of a yes, changes nobody's identity. */
  it.each(["", "  ", "n", "no", "N", "nope", "maybe"])("keeps AGENT_PAT and creates nothing on the answer %j", async (answer) => {
    const { surface, manifests, stored, opened, questions } = app({ secrets: ["AGENT_PAT"], answer });

    const changes = await run(surface);

    expect(questions).toEqual([expect.stringContaining("[y/N]")]);
    const change = changes.find((c) => c.file === APP_CHANGE);
    expect(change?.action).toBe("kept");
    expect(change?.note).toContain("init --app");
    expect([manifests, stored, opened]).toEqual([[], [], []]);
    expect(changes.filter((c) => c.file.includes("AGENT_PAT"))).toEqual([]);
  });

  it.each(["y", "Y", "yes", " Yes "])("switches to the App on the answer %j, and leaves AGENT_PAT in place", async (answer) => {
    const { surface, manifests, stored } = app({ secrets: ["AGENT_PAT"], admin: true, answer });

    const changes = await run(surface);

    expect(manifests).toHaveLength(1);
    expect(changes.find((c) => c.file.startsWith(APP_CHANGE))?.action).toBe("created");
    expect(stored.map(({ name }) => name)).toEqual(["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"]);
    const pat = changes.find((c) => c.file === "secret AGENT_PAT");
    expect(pat?.action).toBe("kept");
    expect(pat?.note).toMatch(/can be deleted/);
    expect(pat?.note).toMatch(/revoke/);
  });

  /** Nobody is asked where there is no PAT to switch from, or an App already. */
  it.each([[[]], [["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY", "AGENT_PAT"]]])("asks nothing with the secrets %j", async (secrets) => {
    const { surface, questions } = app({ secrets, admin: true, answer: "y" });

    await run(surface);

    expect(questions).toEqual([]);
  });

  /**
   * `--app` creates the App with `AGENT_PAT` set, and the PAT stays: the
   * surface has no way to delete a secret, and nothing here writes one but
   * the App's two.
   */
  it("creates the App with --app, without asking, and never deletes or writes AGENT_PAT", async () => {
    const { surface, manifests, stored, questions } = app({ secrets: ["AGENT_PAT"], admin: true, answer: "n" });

    const changes = await run(surface, true);

    expect(questions).toEqual([]);
    expect(manifests).toHaveLength(1);
    expect(changes.find((c) => c.file.startsWith(APP_CHANGE))?.action).toBe("created");
    expect(stored.map(({ name }) => name)).toEqual(["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"]);
    expect(Object.keys(surface).sort()).toEqual(["ask", "openInstall", "orgAdmin", "owner", "register", "secrets", "setSecret"]);
    // Advice, and no more: the one entry naming the PAT says it can go, and does not make it go.
    expect(changes.filter((c) => c.file.includes("AGENT_PAT"))).toEqual([
      {
        file: "secret AGENT_PAT",
        action: "kept",
        note: expect.stringMatching(/can be deleted .* revoke/),
      },
    ]);
    // The live surface too: nothing under setup/ asks `gh` to delete a secret.
    for (const entry of fs.readdirSync("setup").filter((name) => name.endsWith(".ts"))) {
      expect(fs.readFileSync(path.join("setup", entry), "utf8")).not.toMatch(/"secret",\s*"(delete|remove)"/);
    }
  });

  /**
   * The advice follows a switch that took: with no PAT there is nothing to
   * retire, and with the App's key refused the PAT is still what the loop
   * writes with.
   */
  it("says nothing about AGENT_PAT where there was none, or where the App's secrets were not both stored", async () => {
    const fresh = app({ secrets: [], admin: true });
    expect((await run(fresh.surface)).filter((c) => c.file.includes("AGENT_PAT"))).toEqual([]);

    const refused = app({ secrets: ["AGENT_PAT"], admin: false });
    const surface: AppSurface = {
      ...refused.surface,
      setSecret: (name) => (name === "AGENT_APP_PRIVATE_KEY" ? "HTTP 403: Resource not accessible" : undefined),
    };
    const changes = await run(surface, true);
    expect(changes.find((c) => c.file === "secret AGENT_APP_PRIVATE_KEY")?.action).toBe("kept");
    expect(changes.filter((c) => c.file.includes("AGENT_PAT"))).toEqual([]);
  });

  it("creates no App where the secrets could not be read, short of --app", async () => {
    const { surface, manifests } = app({ secrets: undefined });

    const changes = await run(surface);

    expect(changes.find((c) => c.file === APP_CHANGE)?.action).toBe("kept");
    expect(manifests).toEqual([]);
  });

  it.each([
    ["an organization admin", { login: "acme", organization: true }, true, { level: "organization", org: "acme" }, ["acme"]],
    ["an organization non-admin", { login: "acme", organization: true }, false, { level: "repository" }, ["acme"]],
    ["unreadable admin status", { login: "acme", organization: true }, undefined, { level: "repository" }, ["acme"]],
    ["a personal account", { login: "octo", organization: false }, true, { level: "repository" }, []],
  ] as const)("stores the secrets for %s where that is shown to reach", async (_who, owner, admin, placement, asked) => {
    const scenario = app({ secrets: [], owner, admin });

    const changes = await run(scenario.surface);

    expect(scenario.stored.map((s) => s.placement)).toEqual([placement, placement]);
    expect(scenario.asked).toEqual(asked);
    expect(changes.find((c) => c.file === "secret AGENT_APP_ID")?.note).toBe(
      placement.level === "organization" ? "on the organization acme, for every repository in it" : "on this repository",
    );
  });

  /**
   * An org admin's `gh` commonly lacks `admin:org`, which an organization
   * secret needs (#330 review): each write refused there is retried on the
   * repository, which every workflow here also reads.
   */
  it("stores on the repository where the organization refuses", async () => {
    const scenario = app({ secrets: [], admin: true });
    const tried: string[] = [];
    const surface: AppSurface = {
      ...scenario.surface,
      setSecret: (name, _value, placement) => {
        tried.push(`${name} ${placement.level}`);
        return placement.level === "organization" ? "HTTP 403: needs admin:org" : undefined;
      },
    };

    const changes = await run(surface);

    expect(tried).toEqual([
      "AGENT_APP_ID organization",
      "AGENT_APP_ID repository",
      "AGENT_APP_PRIVATE_KEY organization",
      "AGENT_APP_PRIVATE_KEY repository",
    ]);
    for (const name of ["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"]) {
      const change = changes.find((c) => c.file === `secret ${name}`);
      expect(change?.action).toBe("created");
      expect(change?.note).toContain("on this repository, since GitHub refused it on the organization acme (HTTP 403: needs admin:org)");
    }
  });

  it("names where to make a new key when the organization and the repository both refuse", async () => {
    const scenario = app({ secrets: [], admin: true });
    const surface: AppSurface = { ...scenario.surface, setSecret: (_n, _v, p) => `HTTP 403: no ${p.level}` };

    const changes = await run(surface);

    const key = changes.find((c) => c.file === "secret AGENT_APP_PRIVATE_KEY");
    expect(key?.action).toBe("kept");
    expect(key?.note).toContain("(HTTP 403: no organization) and on this repository (HTTP 403: no repository)");
    expect(key?.note).toContain("https://github.com/organizations/acme/settings/apps/acme-loop-bot");
    expect(key?.note).not.toContain("PRIVATE KEY-----");
  });

  it("names where to make a new key when GitHub refuses to store it", async () => {
    const scenario = app({ secrets: [], admin: false });
    const surface: AppSurface = { ...scenario.surface, setSecret: () => "HTTP 403: Resource not accessible" };

    const changes = await run(surface);

    const key = changes.find((c) => c.file === "secret AGENT_APP_PRIVATE_KEY");
    expect(key?.action).toBe("kept");
    expect(key?.note).toContain("https://github.com/organizations/acme/settings/apps/acme-loop-bot");
    expect(key?.note).not.toContain("PRIVATE KEY-----");
  });
});

/**
 * The labels (#236). `init` creates a missing one and edits one whose colour or
 * description is not §3's, so an existing install picks up a recolour on its
 * next run, and deletes a retired one that nothing open still carries.
 */
describe("init converges the labels the loop owns", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const adopted = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-labels-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    return root;
  };

  /**
   * GitHub, as far as this step talks to it: a label list that a write really
   * changes, so a second run reads what the first one left.
   */
  const github = (start: readonly RepoLabel[], carriers: Readonly<Record<string, readonly number[] | undefined>> = {}) => {
    let labels = [...start];
    const sent: string[] = [];
    const surface: LabelSurface = {
      labels: () => labels,
      carriers: (name) => (name in carriers ? carriers[name] : []),
      create: (label) => {
        sent.push(`create ${label.name}`);
        labels = [...labels, { ...label, color: label.color.toLowerCase() }];
        return undefined;
      },
      edit: (label) => {
        sent.push(`edit ${label.name}`);
        labels = labels.map((l) => (l.name === label.name ? { ...label, color: label.color.toLowerCase() } : l));
        return undefined;
      },
      remove: (name) => {
        sent.push(`delete ${name}`);
        labels = labels.filter((l) => l.name !== name);
        return undefined;
      },
    };
    return { surface, sent, now: () => labels };
  };

  /** The labels as an install made before #236 left them: the old colours, and `agent:in-progress`. */
  const OLD: readonly RepoLabel[] = [
    { name: "agent:implement", color: "0e8a16", description: "Ready for the implement workflow to run" },
    { name: "agent:review", color: "1d76db", description: "PR is ready for the automated review workflow" },
    { name: "agent:fix", color: "1d76db", description: "Address review feedback on this PR" },
    { name: "agent:update-branch", color: "5319e7", description: "Refresh this PR branch from its base branch" },
    { name: "agent:in-progress", color: "fbca04", description: "An agent run is currently active" },
    { name: "agent:blocked", color: "b60205", description: "A run failed or was refused; needs human attention" },
    { name: "agent:follow-ups", color: "0052cc", description: "This PR's review recorded out-of-scope findings" },
    { name: "needs-triage", color: "ededed", description: "theirs" },
  ];

  const OWNED = [...TRIGGER_LABELS, ...STATE_LABELS, ...(ADVISORY_LABELS["follow-ups"] ?? [])].filter((label) =>
    label.name.startsWith("agent:"),
  );

  const labelChanges = (changes: readonly { file: string; action: string; note?: string }[]) =>
    changes.filter((c) => c.file.startsWith("label "));

  it("recolours an old install, and a second run reports every label unchanged", async () => {
    const root = adopted();
    const { surface, sent, now } = github(OLD);

    const first = await init({ dir: root, app: noApp, github: offline, labels: surface });

    for (const label of OWNED) {
      expect(first.find((c) => c.file === `label "${label.name}"`)?.action, label.name).toBe("updated");
      const held = now().find((l) => l.name === label.name);
      expect(held?.color.toUpperCase()).toBe(label.color);
      expect(held?.description).toBe(label.description);
    }
    expect(first.find((c) => c.file === 'label "agent:in-progress"')?.action).toBe("deleted");
    expect(now().map((l) => l.name)).not.toContain("agent:in-progress");

    const writes = sent.length;
    const second = await init({ dir: root, app: noApp, github: offline, labels: surface });

    expect(labelChanges(second).map((c) => c.action)).toEqual(OWNED.map(() => "unchanged"));
    expect(sent).toHaveLength(writes);
  });

  /** The triage vocabulary is an adopter's, so its colours are theirs too. */
  it("touches no label outside agent:*", async () => {
    const root = adopted();
    const { surface, sent } = github(OLD);

    await init({ dir: root, app: noApp, github: offline, labels: surface });

    expect(sent.filter((write) => !write.includes(" agent:"))).toEqual([]);
  });

  it("creates a label that does not exist", async () => {
    const root = adopted();
    const { surface, sent } = github(OLD.filter((label) => label.name !== "agent:fix"));

    const changes = await init({ dir: root, app: noApp, github: offline, labels: surface });

    expect(changes.find((c) => c.file === 'label "agent:fix"')?.action).toBe("created");
    expect(sent).toContain("create agent:fix");
  });

  /**
   * Deleting a label strips it from everything carrying it, so a retired label
   * still on an open issue or pull request is left, and named with where.
   */
  it("leaves a retired label that is still in use, and says where", async () => {
    const root = adopted();
    const { surface, sent } = github(
      [...OLD, { name: "agent:queued", color: "ededed", description: "" }],
      { "agent:in-progress": [12, 34] },
    );

    const changes = await init({ dir: root, app: noApp, github: offline, labels: surface });

    const kept = changes.find((c) => c.file === 'label "agent:in-progress"');
    expect(kept?.action).toBe("kept");
    expect(kept?.note).toContain("#12, #34");
    expect(kept?.note).toContain('gh label delete "agent:in-progress" --yes');
    expect(sent).not.toContain("delete agent:in-progress");
    expect(changes.find((c) => c.file === 'label "agent:queued"')?.action).toBe("deleted");
  });

  it("leaves a retired label where whether it is in use could not be read", async () => {
    const root = adopted();
    const { surface, sent } = github(OLD, { "agent:in-progress": undefined });

    const changes = await init({ dir: root, app: noApp, github: offline, labels: surface });

    expect(changes.find((c) => c.file === 'label "agent:in-progress"')?.action).toBe("kept");
    expect(sent).not.toContain("delete agent:in-progress");
  });

  it("says what to run where the labels could not be listed, and writes none", async () => {
    const root = adopted();

    const changes = await init({ dir: root, app: noApp, github: offline, labels: noLabels });

    const kept = changes.find((c) => c.file === "labels");
    expect(kept?.action).toBe("kept");
    // `--force`, so a label that exists is recoloured rather than refused, and
    // `; `, so one that fails does not stop the rest.
    for (const label of OWNED) expect(kept?.note).toContain(`${labelCommand(label)} --force`);
    expect(kept?.note).not.toContain("&&");
    expect(kept?.note?.split("; gh label create")).toHaveLength(OWNED.length);
  });

  it("names a refused write with the command that would make it", async () => {
    const root = adopted();
    const { surface } = github(OLD.filter((label) => label.name !== "agent:fix"));

    const changes = await init({
      dir: root,
      app: noApp,
      github: offline,
      labels: { ...surface, create: () => "HTTP 403: Resource not accessible by integration" },
    });

    const kept = changes.find((c) => c.file === 'label "agent:fix"');
    expect(kept?.action).toBe("kept");
    expect(kept?.note).toContain("HTTP 403");
    expect(kept?.note).toContain(labelCommand(OWNED.find((label) => label.name === "agent:fix") as RepoLabel));
  });
});

/**
 * `doctor` is the other half: every check below is a row of `docs/ADOPTING.md`
 * §0's table, for a failure that announces itself as something else. The facts it cannot read
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
    await init({ dir: root, app: noApp, github: offline, labels: noLabels });
    return root;
  };

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
      "agent:blocked",
    ],
    visibility: "private",
    releases: [`v${manifest.version}`],
    actionsPolicies: [],
    // Unset, which is the budget's default of 3.
    maxFixRounds: null,
    // Unset, which is every limit at today's value.
    timeoutMinutes: Object.fromEntries(TIMEOUT_VARIABLES.map((variable) => [variable.name, null])),
  });

  /** The installed caller file holding a job, repo-relative as `doctor` names it. */
  const callerFileOf = (root: string, job: string): string => {
    const dir = path.join(root, ".github", "workflows");
    const file = fs.readdirSync(dir).find((entry) => jobSpan(fs.readFileSync(path.join(dir, entry), "utf8"), job));
    expect(file, `no installed caller file holds a \`${job}\` job`).toBeDefined();
    return `.github/workflows/${file ?? ""}`;
  };

  /**
   * Break one caller, and insist that the break landed. Every scenario below is
   * a text edit against the real reference callers, so a comment reworded there
   * would otherwise turn a scenario into a test of nothing that still passes.
   *
   * The edit is confined to the caller's own job (#225): `init` installs one
   * caller file per side, so a scope removed with a file-wide `replace` would
   * land on whichever caller came first. The job runs from its `  <id>:` line
   * to the next job's, comments above that next job included.
   */
  const edit = (root: string, job: string, change: (text: string) => string): void => {
    const full = path.join(root, ...callerFileOf(root, job).split("/"));
    const text = fs.readFileSync(full, "utf8");
    const { from, to } = jobSpan(text, job) ?? { from: 0, to: 0 };
    const before = text.slice(from, to);
    const after = change(before);

    expect(after).not.toBe(before);
    fs.writeFileSync(full, `${text.slice(0, from)}${after}${text.slice(to)}`);
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
   * Both caller layouts are supported (#225), and `doctor` says what each one
   * means: the merged one passes quietly, the six-file one passes with a note
   * suggesting the merge, and the one shape that does harm, a reusable workflow
   * called twice, fails whichever files the two callers sit in.
   */
  describe("the caller layout", () => {
    const sixFiles = (): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
      roots.push(root);
      fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      sixFileTree(root, `v${manifest.version}`);
      return root;
    };
    const workflowsDir = (root: string): string => path.join(root, ".github", "workflows");
    const lines = (text: string, tag: string, check: string): readonly string[] =>
      text.split("\n").filter((line) => line.startsWith(`${tag}  ${check}:`));

    it("says nothing about the layout of a merged install", async () => {
      const { code, out, err } = await check(await installed(), healthy());

      expect(code).toBe(0);
      expect(`${out}${err}`).not.toContain("caller layout");
    });

    it("notes the six-file layout and suggests the merged one, without failing it", async () => {
      const { code, out, err } = await check(sixFiles(), healthy());

      expect(err).toBe("");
      expect(code).toBe(0);
      const said = lines(out, "note", "caller layout");
      expect(said).toHaveLength(2);
      const pr = said.find((line) => line.includes("pull request"));
      for (const job of ["review", "fix", "update-branch", "follow-ups"]) {
        expect(pr).toContain(`.github/workflows/agent-${job}.yml`);
      }
      expect(pr).toContain("4 files");
      const issue = said.find((line) => line.includes("an issue"));
      expect(issue).toContain(".github/workflows/agent-implement.yml");
      expect(issue).toContain(".github/workflows/agent-implement-prd.yml");
      expect(out).toContain("examples/callers/pr.yml");
      expect(out).toContain("examples/callers/issue.yml");
    });

    /**
     * Declining `follow-ups` is deleting its job from the PR-side caller file,
     * or not copying its file in the six-file layout, and either is a choice
     * rather than a fault.
     */
    it("reads a missing follow-ups caller as declined in the merged layout", async () => {
      const root = await installed();
      const before = await check(root, healthy());
      const pr = path.join(workflowsDir(root), "agent-pr.yml");
      fs.writeFileSync(pr, withoutJob(fs.readFileSync(pr, "utf8"), "follow-ups"));

      const after = await check(root, healthy());

      expect(after.code).toBe(0);
      expect(after.err).toBe("");
      // One fewer caller counted, and not one finding more.
      expect(after.out).toBe(before.out.replace("6 caller(s)", "5 caller(s)"));
    });

    it("reads a missing follow-ups caller as declined in the six-file layout", async () => {
      const root = sixFiles();
      fs.rmSync(path.join(workflowsDir(root), "agent-follow-ups.yml"));

      const { code, out, err } = await check(root, healthy());

      expect(code).toBe(0);
      expect(err).toBe("");
      expect(out).not.toContain("follow-ups");
    });

    it("fails a reusable workflow called twice from one caller file, naming both jobs", async () => {
      const root = await installed();
      const pr = path.join(workflowsDir(root), "agent-pr.yml");
      const text = fs.readFileSync(pr, "utf8");
      const { from, to } = jobSpan(text, "fix") ?? { from: 0, to: 0 };
      const copy = text.slice(from, to).replace(/^  fix:$/m, "  fix-again:");
      fs.writeFileSync(pr, `${text.slice(0, to)}${copy}${text.slice(to)}`);

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      const said = lines(err, "FAIL", "duplicate caller");
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("`fix.yml`");
      expect(said[0]).toContain(".github/workflows/agent-pr.yml's `fix` job");
      expect(said[0]).toContain(".github/workflows/agent-pr.yml's `fix-again` job");
    });

    /**
     * The half-merged tree: a merged caller file copied in beside the six it
     * replaces. Every caller is then called twice, and the layout note stands
     * down, since the duplicates' fix is the one that matters.
     */
    it("fails a reusable workflow called from two caller files, naming both", async () => {
      const root = sixFiles();
      fs.copyFileSync(path.join("examples", "callers", "pr.yml"), path.join(workflowsDir(root), "agent-pr.yml"));

      const { code, out, err } = await check(root, healthy());

      expect(code).toBe(1);
      const said = lines(err, "FAIL", "duplicate caller");
      expect(said).toHaveLength(4);
      const review = said.find((line) => line.includes("`review.yml`"));
      expect(review).toContain(".github/workflows/agent-pr.yml's `review` job");
      expect(review).toContain(".github/workflows/agent-review.yml's `review` job");
      // The issue side is still spread over two files, and still noted.
      expect(lines(out, "note", "caller layout")).toHaveLength(1);
      expect(lines(out, "note", "caller layout")[0]).toContain("an issue");
    });

    /**
     * The per-job grant checks apply to each caller inside a merged caller
     * file: one job short of a scope is named, and its neighbours are not.
     */
    it("names the one under-granted job in a merged caller file", async () => {
      const root = await installed();
      edit(root, "update-branch", (text) => text.replace(/^ *contents: write$/m, ""));

      const { code, err } = await check(root, healthy());

      expect(code).toBe(1);
      const said = err.split("\n").filter((line) => line.startsWith("FAIL"));
      expect(said.length).toBeGreaterThan(0);
      for (const line of said) {
        expect(line).toContain(".github/workflows/agent-pr.yml grants the `update-branch` job no `contents: write`");
      }
    });
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
    /** The one caller file `init` installs that runs on the trigger: the PR side (#225). */
    const callers = [".github/workflows/agent-pr.yml"];

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
      expect(err).not.toContain(".github/workflows/agent-issue.yml");
      expect(err).toContain("gh api --method POST repos/{owner}/{repo}/actions/policies");
      expect(err).toContain("Settings → Actions → Policies");
    });

    /** A policy that allows nothing for a caller is no policy for it. */
    it.each([
      ["one caller file missing", allowing([".github/workflows/agent-review.yml"])],
      ["excluded", allowing([], { exclude: [".github/workflows/agent-pr.yml"] })],
      ["only in evaluate mode", allowing(callers, { enforcement: "evaluate" })],
      ["another event only", allowing(callers, { allowedEvents: ["push"] })],
    ] as const)("fails on a policy that is %s", async (_what, policy) => {
      const { code, err } = await check(await installed(), { ...healthy(), visibility: "public", actionsPolicies: [policy] });

      expect(code).toBe(1);
      expect(err).toContain(".github/workflows/agent-pr.yml");
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

      const { result: actionsPolicies } = await replayed({ policies: [created] }, () => readPolicies(root));
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

      const { result: actionsPolicies } = await replayed({ policies: [theirs] }, () => readPolicies(root));
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

      const { result: actionsPolicies } = await replayed({ policies: [{ id: 4, name: "theirs", enforcement: "active" }], unreadable: [4] }, () =>
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
   * The PRD chain has no slice PRs (#249): every slice is reviewed on the PRD
   * PR, whose base is the default branch, so a CI filtered to the default
   * branch already runs on it. Neither check that slice PRs needed is left to
   * fire on such a CI.
   */
  it("runs no check about slice PRs on a CI filtered to the default branch", async () => {
    const root = await installed();
    fs.writeFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      ["name: CI", "on:", "  pull_request:", "    branches: [main]", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: true", ""].join("\n"),
    );

    const { code, out, err } = await check(root, healthy());

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).not.toMatch(/slice PR/i);
  });

  /**
   * The `closed` trigger moved the chain on from a slice PR merged by hand,
   * and the review listens for it no more (#249). The PR-side caller file
   * lists it for `follow-ups` (#225), so the review's caller fires on it and
   * every review job skips: harmless, so not worth a word.
   */
  it("does not flag a review caller whose file listens on closed", async () => {
    const root = await installed();
    expect(fs.readFileSync(path.join(root, ...callerFileOf(root, "review").split("/")), "utf8")).toContain(
      "types: [labeled, closed]",
    );

    const { code, out, err } = await check(root, healthy());

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).not.toContain("closed");
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
   * `docs/ADOPTING.md` §1, "GitHub Actions is not permitted to create or
   * approve pull requests". A PAT bypasses the setting entirely — a user token is
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
    edit(root, "fix", (text) => text.replace(/^ *packages: read$/m, ""));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("packages: read");
    expect(err).toContain(".github/workflows/agent-pr.yml grants the `fix` job no `packages: read`");
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
    edit(root, "review", (text) => text.replace(/^ *checks: read$/m, ""));

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
      // grant is the ceiling for all of them. `review.yml` has several jobs,
      // and its `post-review` job holds the `contents: write` the review job
      // narrows back to `read` (#133, #257).
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

  /**
   * `doctor` points an adopter at the reference caller file holding a job, from
   * a fixed list because `diagnose` reads nothing at run time. That list is
   * the reference set's, file for file (#225).
   */
  it("knows which reference caller file holds each caller", () => {
    const dir = path.join(PACKAGE_DIR, "examples", "callers");
    const held = Object.fromEntries(
      fs
        .readdirSync(dir)
        .filter((entry) => entry.endsWith(".yml"))
        .flatMap((entry) =>
          callersIn(fs.readFileSync(path.join(dir, entry), "utf8"), manifest.name, entry).map(
            (caller) => [caller.workflow, entry] as const,
          ),
        ),
    );

    expect(REFERENCE_CALLER_FILES).toEqual(held);
  });

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

    // Read by the workflow each caller calls, not by file: a reference caller
    // file holds one side's callers (#225).
    const dir = path.join(PACKAGE_DIR, "examples", "callers");
    const references = fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith(".yml"))
      .flatMap((entry) => callersIn(fs.readFileSync(path.join(dir, entry), "utf8"), manifest.name, entry));
    const granted = new Map(
      [...bound.keys()].map((name) => {
        const caller = references.find((held) => held.workflow === name);
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
      edit(root, workflow, (text) =>
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
        // The file and the job: in a caller file holding several callers, the
        // file alone does not say which one is short (#225).
        expect(said).toContain(`${callerFileOf(root, workflow)} grants the \`${workflow}\` job`);
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
    edit(root, "fix", (text) =>
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
      "  actions: read",
      "  checks: read",
      "  contents: write",
      "  issues: read",
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
   * installed before the thread resolve grants `contents: read`, which was every
   * scope the review job itself used — so nothing about the caller looks wrong,
   * and what it costs is the whole workflow: a called job cannot hold more than
   * its caller granted, and GitHub refuses the elevation by failing the run
   * before any job starts. There is no job log to find that in, which is what
   * makes this `doctor`'s to say. The per-cell scenarios above remove the line
   * entirely; this one keeps it at the value that used to be right.
   */
  it("reports a review caller that still grants contents: read", async () => {
    const root = await installed();
    edit(root, "review", (text) => text.replace(/^( *)contents: write$/m, "$1contents: read"));

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
      edit(root, workflow, (text) =>
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
   * A caller inside a caller file whose top level grants nothing (#225): a job
   * there that lost its own block runs with no scope at all. One finding about
   * the block, naming the job, rather than one per scope telling the adopter to
   * add each to the top-level block, which would grant it to every caller in
   * the file.
   */
  it("names a job in a caller file that grants nothing above jobs:, and gives it its own block", async () => {
    const root = await installed();
    edit(root, "fix", (text) => text.replace(/^    permissions:\n(?:(?:      .*)?\n)*?(?=    #)/m, ""));

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    const said = err.split("\n").filter((line) => line.startsWith("FAIL") && line.includes("`fix` job"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(".github/workflows/agent-pr.yml");
    expect(said[0]).toContain("grants nothing");
    expect(err).toContain("the `fix` job's in examples/callers/pr.yml");
    expect(err).not.toMatch(/to the workflow's top-level `permissions:` block/);
    // The other callers in the file keep their own blocks, and are fine.
    expect(err).not.toContain("`review` job");
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
    edit(root, "review", (text) => text.replace(/^ *checks: read$/m, ""));

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
    // The reference caller file holding that job, not one named after the
    // workflow: a reference file holds one side's callers (#225).
    expect(err).toContain("the `review` job's in examples/callers/pr.yml");
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
    edit(root, "fix", (text) => text.replace(`@v${manifest.version}`, "@main"));

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
    edit(root, "fix", (text) => text.replace(`@v${manifest.version}`, "@v0.1.1"));

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
    edit(root, "fix", (text) => text.replace(`@v${manifest.version}`, "@v0.0.1"));

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
    edit(root, "review", (text) => text.replace(/^  review:$/m, "  reviewer:"));

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
    edit(root, "review", (text) =>
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
    edit(root, "review", (text) =>
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
    edit(root, "review", (text) =>
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
   * That is the three `GITHUB_TOKEN` failures in `docs/ADOPTING.md` §1, "`GITHUB_TOKEN`
   * pushes start CI that waits for approval", "`GITHUB_TOKEN` cannot mark a pull
   * request ready for review" and "A label added with `GITHUB_TOKEN` is a silent
   * no-op", reached from the one place nothing else here looks.
   */
  it("fails a caller that does not pass AGENT_PAT to the workflow it calls", async () => {
    const root = await installed();
    edit(root, "fix", (text) =>
      text.replace(/^ *AGENT_PAT: .*$/m, ""),
    );

    const { code, err } = await check(root, healthy());

    expect(code).toBe(1);
    expect(err).toContain("AGENT_PAT");
    expect(err).toContain(".github/workflows/agent-pr.yml does not hand `AGENT_PAT` to `fix.yml`");
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

    expect(`${out}${err}`).not.toContain("`follow-ups.yml`");
    expect(`${out}${err}`).not.toContain("`follow-ups` job");
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
    edit(root, "fix", (text) =>
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
    edit(root, "fix", (text) => text.replace(/^ *AGENT_PAT: .*$/m, ""));

    const { out, err } = await check(root, {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
    });

    expect(out).toContain("secrets wiring");
    expect(err).not.toContain("secrets wiring");
  });

  /**
   * **The loop's identity** (#321, PRD #314): which of the App, the PAT or
   * neither the loop writes as, the App set up by halves, and a caller that
   * does not pass the App's secrets on while they are set. Ruled through
   * `diagnose`, on the callers of a constructed tree and constructed facts, in
   * both layouts, and with the facts unreadable, which is never a pass.
   */
  describe("the loop's identity", () => {
    const APP = ["AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"];
    const withSecrets = (...secrets: string[]): RepoFacts => ({
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN", ...secrets],
    });
    const rule = (root: string, facts: RepoFacts): readonly Finding[] =>
      diagnose(readInstalledCallers(root, manifest.name), facts);
    const of = (findings: readonly Finding[], check: string): readonly Finding[] =>
      findings.filter((finding) => finding.check === check);
    const sixFiles = (): string => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-doctor-"));
      roots.push(root);
      fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      sixFileTree(root, `v${manifest.version}`);
      return root;
    };
    /** One caller's secrets, without one of the App's: confined to its job, as `edit` is. */
    const dropSecret = (root: string, file: string, job: string, name: string): void => {
      const full = path.join(root, ...file.split("/"));
      const text = fs.readFileSync(full, "utf8");
      const { from, to } = jobSpan(text, job) ?? { from: 0, to: 0 };
      const before = text.slice(from, to);
      const after = before.replace(new RegExp(`^ *${name}: .*\\n`, "m"), "");
      expect(after).not.toBe(before);
      fs.writeFileSync(full, `${text.slice(0, from)}${after}${text.slice(to)}`);
    };

    it.each([
      ["the App", [...APP], "note", "The loop writes as its GitHub App"],
      ["the App, with a PAT behind it", [...APP, "AGENT_PAT"], "note", "The loop writes as its GitHub App"],
      ["the PAT", ["AGENT_PAT"], "note", "The loop writes as `AGENT_PAT`'s owner"],
      ["neither", [], "error", "Neither the loop's GitHub App"],
    ] as const)("reports %s as the identity in use", async (_, secrets, severity, says) => {
      const said = of(rule(await installed(), withSecrets(...secrets)), "identity");

      expect(said).toHaveLength(1);
      expect(said[0]?.severity).toBe(severity);
      expect(said[0]?.problem).toContain(says);
    });

    it("names no identity where the secrets could not be read, and says it is unknown", async () => {
      const findings = rule(await installed(), { ...healthy(), secrets: undefined });

      expect(of(findings, "identity")).toEqual([]);
      expect(of(findings, "App secrets")).toEqual([]);
      expect(of(findings, "secrets")[0]?.fix).toContain("Which identity the loop writes as is unknown");
    });

    it.each([
      ["an ID without a key", "AGENT_APP_ID", "AGENT_APP_PRIVATE_KEY"],
      ["a key without an ID", "AGENT_APP_PRIVATE_KEY", "AGENT_APP_ID"],
    ])("fails an App with %s, naming the half that is missing", async (_, set, unset) => {
      const root = await installed();

      for (const pat of [["AGENT_PAT"], []]) {
        const said = of(rule(root, withSecrets(set, ...pat)), "App secrets");
        expect(said).toHaveLength(1);
        expect(said[0]?.severity).toBe("error");
        expect(said[0]?.problem).toContain(`\`${set}\` is set and \`${unset}\` is not`);
        expect(said[0]?.problem).toContain(pat.length > 0 ? "`AGENT_PAT`'s owner" : "`GITHUB_TOKEN`");
        expect(said[0]?.fix).toContain(`Set \`${unset}\``);
      }
      // Half an App is no App: the identity is the PAT's.
      expect(of(rule(root, withSecrets(set, "AGENT_PAT")), "identity")[0]?.problem).toContain("`AGENT_PAT`'s owner");
    });

    it("finds nothing half-configured in a whole App, or in none", async () => {
      const root = await installed();

      expect(of(rule(root, withSecrets(...APP)), "App secrets")).toEqual([]);
      expect(of(rule(root, withSecrets("AGENT_PAT")), "App secrets")).toEqual([]);
    });

    it("passes a repository init has just set up, on the App", async () => {
      const { code, out, err } = await check(await installed(), withSecrets(...APP));

      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("note  identity: The loop writes as its GitHub App");
    });

    describe.each([
      ["merged", (): Promise<string> => installed(), ".github/workflows/agent-pr.yml", ".github/workflows/agent-issue.yml"],
      ["six-file", (): Promise<string> => Promise.resolve(sixFiles()), ".github/workflows/agent-fix.yml", ".github/workflows/agent-implement.yml"],
    ])("the App's secrets passed through, in the %s layout", (_, tree, fixFile, implementFile) => {
      it("fails each caller that writes and does not pass them, naming it", async () => {
        const root = await tree();
        dropSecret(root, fixFile, "fix", "AGENT_APP_ID");
        dropSecret(root, implementFile, "implement", "AGENT_APP_PRIVATE_KEY");

        const said = of(rule(root, withSecrets(...APP, "AGENT_PAT")), "App secrets wiring");

        expect(said.map((finding) => finding.severity)).toEqual(["error", "error"]);
        const fix = said.find((finding) => finding.problem.includes("`fix.yml`"));
        expect(fix?.problem).toContain(`${fixFile} does not hand \`AGENT_APP_ID\` to \`fix.yml\` on the \`fix\` job`);
        expect(fix?.fix).toContain("AGENT_APP_ID: ${{ secrets.AGENT_APP_ID }}");
        const implement = said.find((finding) => finding.problem.includes("`implement.yml`"));
        expect(implement?.problem).toContain(`${implementFile} does not hand \`AGENT_APP_PRIVATE_KEY\``);
      });

      it("raises nothing about them where the App is not set up", async () => {
        const root = await tree();
        dropSecret(root, fixFile, "fix", "AGENT_APP_ID");

        expect(of(rule(root, withSecrets("AGENT_PAT")), "App secrets wiring")).toEqual([]);
        // Half an App is its own finding, and no caller can make it work.
        expect(of(rule(root, withSecrets("AGENT_APP_ID", "AGENT_PAT")), "App secrets wiring")).toEqual([]);
      });

      it("warns rather than passes where the secrets could not be read", async () => {
        const root = await tree();
        dropSecret(root, fixFile, "fix", "AGENT_APP_ID");

        const said = of(rule(root, { ...healthy(), secrets: undefined }), "App secrets wiring");

        expect(said).toHaveLength(1);
        expect(said[0]?.severity).toBe("warning");
        expect(said[0]?.problem).toContain(fixFile);
      });

      it("accepts a caller that inherits every secret", async () => {
        const root = await tree();
        const full = path.join(root, ...fixFile.split("/"));
        const text = fs.readFileSync(full, "utf8");
        const { from, to } = jobSpan(text, "fix") ?? { from: 0, to: 0 };
        const job = text.slice(from, to).replace(/^    secrets:\n(?:      .*\n)+/m, "    secrets: inherit\n");
        expect(job).toContain("secrets: inherit");
        fs.writeFileSync(full, `${text.slice(0, from)}${job}${text.slice(to)}`);

        expect(of(rule(root, withSecrets(...APP)), "App secrets wiring")).toEqual([]);
      });

      /**
       * `follow-ups` writes with the workflow token and declares none of the
       * loop's write secrets, so it passes none, and that is never this error.
       */
      it("never raises it on follow-ups", async () => {
        const root = await tree();
        const findings = [
          ...rule(root, withSecrets(...APP)),
          ...rule(root, { ...healthy(), secrets: undefined }),
        ];

        expect(findings.filter((finding) => finding.problem.includes("`follow-ups.yml`"))).toEqual([]);
        expect(of(findings, "App secrets wiring")).toEqual([]);
      });
    });

    /**
     * A caller handed the whole App writes with it, so the PAT it does not
     * pass is never reached; and the App, like the PAT, is a writer for the
     * rulings that ask whether a label can fire an event or a PR be opened.
     */
    it("asks for no PAT wire, PAT or repository setting where the App does the writing", async () => {
      const root = await installed();
      edit(root, "fix", (text) => text.replace(/^ *AGENT_PAT: .*$/m, ""));

      const findings = rule(root, { ...withSecrets(...APP), canCreatePullRequests: false });

      expect(of(findings, "secrets wiring")).toEqual([]);
      expect(of(findings, "fix rounds without a PAT")).toEqual([]);
      expect(of(findings, "actions can open PRs")[0]?.severity).toBe("warning");
      expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
    });
  });

  /**
   * **The fix-round budget without a PAT** (#204, PRD #200). A review with
   * budget left starts a fix round itself by adding `agent:fix`, and a label
   * added with `GITHUB_TOKEN` fires no event, so without the PAT no automatic
   * round ever starts. The default counts: a repository that set nothing has a
   * budget of 3, which is every repository `init` has just finished with.
   *
   * A warning, not an error: the `AGENT_PAT` row is already the error for the
   * same missing secret, and this one must not add a second exit code to it.
   */
  it("warns that no fix round can start where the default budget has no PAT behind it", async () => {
    const { code, out, err } = await check(await installed(), {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
      maxFixRounds: null,
    });

    expect(out).toContain("warn  fix rounds without a PAT");
    expect(out).toMatch(/budget of 3 \(the default\)/);
    expect(out).toContain(FIX_ROUNDS_VARIABLE);
    expect(err).not.toContain("fix rounds without a PAT");
    // The missing PAT itself, which is the acceptance: reported, and failing.
    expect(err).toMatch(/FAIL  identity: Neither the loop's GitHub App .* nor the `AGENT_PAT` secret is set/);
    expect(code).toBe(1);
  });

  it("names a budget that was set, and says nothing where it is 0", async () => {
    const noPat = { ...healthy(), secrets: ["CLAUDE_CODE_OAUTH_TOKEN"] };

    const five = await check(await installed(), { ...noPat, maxFixRounds: "5" });
    expect(five.out).toMatch(/budget of 5 \(`AGENT_MAX_FIX_ROUNDS`\)/);

    const none = await check(await installed(), { ...noPat, maxFixRounds: "0" });
    expect(none.out).not.toContain("fix rounds without a PAT");
  });

  /**
   * **Unreadable stays unreadable**, on both facts. Secrets and variables are
   * readable only with more than a checkout, and "nobody could ask" is not "the
   * PAT is missing" nor "the variable is unset": a budget read out of a
   * variable nobody could list would be a default nobody knows applies.
   */
  it("does not rule on the budget where the secrets or the variable could not be read", async () => {
    const unreadVariable = await check(await installed(), {
      ...healthy(),
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
      maxFixRounds: undefined,
    });
    expect(unreadVariable.out).not.toContain("fix rounds without a PAT");

    const unreadSecrets = await check(await installed(), { ...healthy(), secrets: undefined });
    expect(unreadSecrets.out).not.toContain("fix rounds without a PAT");
    expect(unreadSecrets.out).toMatch(/could not read the actions secrets/i);
    expect(unreadSecrets.code).toBe(0);
  });

  /**
   * **A variable that is not a count** fails every review: the budget step
   * refuses it rather than guessing a number of rounds out of `three` or
   * `-1`. An error, and the same test the step applies.
   */
  it("errors on a budget variable that is not a non-negative integer", async () => {
    for (const value of ["three", "-1", "1.5", " 2"]) {
      const { code, err } = await check(await installed(), { ...healthy(), maxFixRounds: value });
      expect(err, value).toContain("FAIL  fix-round budget");
      expect(err, value).toContain(`\`${value}\``);
      expect(code, value).toBe(1);
    }
    for (const value of ["0", "3", "007"]) {
      const { code, err } = await check(await installed(), { ...healthy(), maxFixRounds: value });
      expect(err, value).toBe("");
      expect(code, value).toBe(0);
    }
  });

  /**
   * The default `doctor` assumes is the one the review applies, read out of
   * the budget step itself: two copies of the number, held equal.
   */
  it("assumes the default budget the review applies", () => {
    const review = fs.readFileSync(path.join(".github", "workflows", "review.yml"), "utf8");
    expect(review).toContain(`budget="\${MAX_FIX_ROUNDS:-${DEFAULT_FIX_ROUNDS}}"`);
    expect(review).toContain(`MAX_FIX_ROUNDS: \${{ vars.${FIX_ROUNDS_VARIABLE} }}`);
  });

  /**
   * **A time limit that is not a positive integer** (#220). The agent jobs read
   * theirs straight into `timeout-minutes`, where one GitHub cannot read as a
   * number fails the job before any step, with no comment and the label left
   * on; the review refuses its own on the pull request. An error either way,
   * wherever a caller whose job reads it is installed.
   */
  it("errors on a time limit variable that is not a positive integer", async () => {
    for (const variable of TIMEOUT_VARIABLES) {
      const set = (value: string): RepoFacts => ({
        ...healthy(),
        timeoutMinutes: { ...healthy().timeoutMinutes, [variable.name]: value },
      });

      for (const value of ["0", "-5", "1.5", "thirty", "030", " 30"]) {
        const { code, err } = await check(await installed(), set(value));
        expect(err, `${variable.name}=${value}`).toContain("FAIL  time limit");
        expect(err, `${variable.name}=${value}`).toContain(`\`${variable.name}\` is \`${value}\``);
        expect(code, `${variable.name}=${value}`).toBe(1);
      }
      for (const value of ["1", "45", "120"]) {
        const { code, err } = await check(await installed(), set(value));
        expect(err, `${variable.name}=${value}`).toBe("");
        expect(code, `${variable.name}=${value}`).toBe(0);
      }
    }
  });

  /** …and says nothing about one that was never read. */
  it("does not rule on time limits it could not read", async () => {
    const { code, err } = await check(await installed(), { ...healthy(), timeoutMinutes: undefined });

    expect(err).not.toContain("time limit");
    expect(code).toBe(0);
  });

  /**
   * The defaults `doctor` names are the ones the workflows apply, read out of
   * the workflows: two copies of each number, held equal.
   */
  it("names the default each workflow applies", () => {
    const [agent, review] = TIMEOUT_VARIABLES;
    const workflow = (name: string): string =>
      fs.readFileSync(path.join(".github", "workflows", `${name}.yml`), "utf8");

    expect(agent?.workflows).toEqual(["implement", "implement-prd", "fix", "update-branch"]);
    for (const name of agent?.workflows ?? []) {
      expect(workflow(name)).toContain(`fromJSON(vars.${agent?.name} || '${agent?.defaultMinutes}')`);
    }
    expect(review?.workflows).toEqual(["review"]);
    expect(workflow("review")).toContain(`REVIEW_MINUTES: \${{ vars.${review?.name} }}`);
    expect(workflow("review")).toContain(`own="\${REVIEW_MINUTES:-${review?.defaultMinutes}}"`);
  });

  /**
   * **`auto-fix`, deprecated** (#201, PRD #200 decision 4). The review honours
   * it for one release and wins it over the variable, and the release after
   * stops declaring it, which GitHub answers by failing the caller that still
   * passes it. So a warning now, naming the variable to set and the value that
   * keeps today's behaviour.
   *
   * The gesture is the one an adopter who kept the input has made: the line
   * added to the reference caller's `with:` block.
   */
  const withAutoFix = async (value: string): Promise<string> => {
    const root = await installed();
    edit(root, "review", (text) =>
      text.replace("self-check: review / review", `self-check: review / review\n      auto-fix: ${value}`),
    );
    return root;
  };

  it("warns that auto-fix is deprecated, naming the variable to set instead", async () => {
    for (const [value, budget] of [["true", "1"], ["false", "0"]] as const) {
      const { code, out, err } = await check(await withAutoFix(value), healthy());

      expect(out, value).toContain("warn  auto-fix deprecated");
      expect(out, value).toContain(FIX_ROUNDS_VARIABLE);
      expect(out, value).toContain(`\`${FIX_ROUNDS_VARIABLE}\` to \`${budget}\``);
      expect(err, value).toBe("");
      expect(code, value).toBe(0);
    }
  });

  /** …and an error where its value is one the review refuses outright. */
  it("errors on an auto-fix value the review refuses", async () => {
    const { code, err } = await check(await withAutoFix("yes"), healthy());

    expect(err).toContain("FAIL  auto-fix deprecated");
    expect(code).toBe(1);
  });

  /**
   * **YAML's null is not passed.** `auto-fix:` with nothing after it, `~` and
   * `null` all parse to null, which GitHub hands the review as the empty
   * string, and the review reads empty as "not passed". Read through `String`
   * it was the word `null`, and a refused value.
   */
  it("reads an auto-fix left empty or null as not passed", async () => {
    for (const value of ["", "~", "null"]) {
      const noPat = { ...healthy(), secrets: ["CLAUDE_CODE_OAUTH_TOKEN"], maxFixRounds: "5" };
      const { out, err } = await check(await withAutoFix(value), noPat);

      expect(`${out}${err}`, value).not.toContain("auto-fix deprecated");
      // The variable is what the review reads, so it is the budget named.
      expect(out, value).toMatch(/budget of 5 \(`AGENT_MAX_FIX_ROUNDS`\)/);
    }
  });

  /**
   * **An expression is settled at run time**, and may come to `true`, `false`
   * or empty, none of which the review refuses. So still the deprecation, as a
   * warning, and no budget: a round count out of `${{ vars.X }}` is a guess.
   */
  it("warns on an auto-fix expression without ruling on what it comes to", async () => {
    for (const value of ["${{ vars.AUTO_FIX }}", "${{ github.event_name == 'push' }}", "x-${{ vars.A }}"]) {
      const noPat = { ...healthy(), secrets: ["CLAUDE_CODE_OAUTH_TOKEN"] };
      const { out, err } = await check(await withAutoFix(`"${value}"`), noPat);

      expect(out, value).toContain("warn  auto-fix deprecated");
      expect(out, value).not.toContain("refuses it today");
      expect(out, value).not.toContain("fix rounds without a PAT");
      expect(err, value).not.toContain("auto-fix");
    }
  });

  /**
   * The alias wins over the variable, in `doctor` as in the review: `false`
   * is a budget of 0 however the variable reads, so there is no round for a
   * missing PAT to stop; `true` is a budget of 1 even where the variable says
   * 0.
   */
  it("reads the budget from auto-fix where a caller still passes it", async () => {
    const noPat = { ...healthy(), secrets: ["CLAUDE_CODE_OAUTH_TOKEN"] };

    const off = await check(await withAutoFix("false"), { ...noPat, maxFixRounds: "3" });
    expect(off.out).not.toContain("fix rounds without a PAT");

    const on = await check(await withAutoFix("true"), { ...noPat, maxFixRounds: "0" });
    expect(on.out).toMatch(/budget of 1 \(`auto-fix: true`\)/);
  });

  /**
   * **The red check** (#231, #233), optional: each review caller hears whether
   * it is configured, as a note that changes nothing, or half configured, as a
   * warning naming what is missing. The gesture is the one `examples/callers/`
   * invites: its commented-out lines uncommented, all of them or some.
   */
  const withRedCheck = async (blocks: readonly string[]): Promise<string> => {
    const root = await installed();
    edit(root, "review", (text) => {
      let after = text;
      for (const block of blocks) {
        const commented = block.split(INDENT).map((line) => `# ${line}`).join(INDENT);
        expect(after, block).toContain(commented);
        after = after.replace(commented, block);
      }
      return after;
    });
    return root;
  };
  const INDENT = "\n      ";
  const COMMAND = "red-check-command: npx vitest run --reporter=junit --outputFile=junit.xml";
  const REPORT = "red-check-report: junit.xml";
  const GLOBS = ["red-check-test-globs: |", "  tests/**", "  **/*.test.ts"].join(INDENT);

  it("notes that the red check is not configured on a caller init has just installed", async () => {
    const { code, out, err } = await check(await installed(), healthy());

    expect(out).toContain("note  red check: .github/workflows/agent-pr.yml's `review` job does not configure the red check");
    expect(out).toContain("red-check-command");
    expect(out).not.toContain("warn  red check");
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  it("notes that the red check is configured, naming its command and report", async () => {
    const { code, out, err } = await check(await withRedCheck([COMMAND, REPORT, GLOBS]), healthy());

    expect(out).toContain("note  red check: .github/workflows/agent-pr.yml's `review` job configures the red check");
    expect(out).toContain("`npx vitest run --reporter=junit --outputFile=junit.xml`");
    expect(out).toContain("`junit.xml`");
    expect(out).toContain("never a required status");
    expect(out).not.toContain("warn  red check");
    // A note is not a thing to know: the summary counts warnings only.
    expect(out).toContain("0 thing(s) to know");
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /**
   * **Half configured**, a command with no report path or no globs: the job
   * reports itself misconfigured on every review, and the review reads what is
   * red as unknown. A warning naming exactly what is missing, and never an
   * error: the check is evidence for the review, never a required status.
   */
  it("warns that a red check with a command and no report or no globs is half configured", async () => {
    const noGlobs = await check(await withRedCheck([COMMAND, REPORT]), healthy());
    expect(noGlobs.out).toContain("warn  red check");
    expect(noGlobs.out).toContain("sets `red-check-command` but not `red-check-test-globs`, so the red check is half configured");
    expect(noGlobs.out).toContain("fix: Set `red-check-test-globs`");
    expect(noGlobs.code).toBe(0);

    const commandOnly = await check(await withRedCheck([COMMAND]), healthy());
    expect(commandOnly.out).toContain("but not `red-check-report` or `red-check-test-globs`");
    expect(commandOnly.out).toContain("fix: Set `red-check-report` and `red-check-test-globs`");
    expect(commandOnly.out).not.toContain("note  red check");
    expect(commandOnly.err).toBe("");
    expect(commandOnly.code).toBe(0);
  });

  it("warns that red check inputs with no command turn nothing on", async () => {
    const { code, out, err } = await check(await withRedCheck([REPORT]), healthy());

    expect(out).toContain("warn  red check");
    expect(out).toContain("sets `red-check-report` but not `red-check-command`, so the red check is off");
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  /** Empty, null and whitespace-only globs are the input's default: none. */
  it("reads red check inputs left empty, null or blank as not passed", async () => {
    for (const value of ['""', "~", '"  "']) {
      const root = await withRedCheck([COMMAND, REPORT]);
      edit(root, "review", (text) =>
        text.replace(REPORT, `${REPORT}${INDENT}red-check-test-globs: ${value}`),
      );
      const { out } = await check(root, healthy());

      expect(out, value).toContain("but not `red-check-test-globs`");
    }
  });

  /**
   * **No marker label to demand**, and none to create: the rounds spent are
   * counted from the pull request's own verdicts (#201), so `agent:auto-fixed`
   * is retired and a healthy repository passes clean without it.
   */
  it("neither demands nor offers the retired marker label", async () => {
    const root = await installed();
    const { code, out, err } = await check(root, healthy());

    expect(`${out}${err}`).not.toContain("agent:auto-fixed");
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(root, "SETUP.md"), "utf8")).not.toContain("agent:auto-fixed");
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

  /**
   * The budget variable, read the way the secrets are: a repository variable
   * wins over an organization one of the same name, as it does in `vars`, and
   * "not set" is concluded only from lists that were read. Unset is `null`,
   * unreadable is `undefined`, and the two lead to opposite rulings: the first
   * is the default of 3, the second is nothing anybody knows.
   */
  it("reads the budget variable without collapsing unset into unreadable", () => {
    expect(availableVariable(["2"], ["5"], true)).toBe("2");
    expect(availableVariable([], ["5"], true)).toBe("5");
    expect(availableVariable(["2"], undefined, undefined)).toBe("2");
    expect(availableVariable([], [], true)).toBeNull();
    // No organization to ask about: the repository's own list is the answer.
    expect(availableVariable([], undefined, false)).toBeNull();
    // One that may have an organization, whose list could not be read.
    expect(availableVariable([], undefined, true)).toBeUndefined();
    expect(availableVariable([], undefined, undefined)).toBeUndefined();
    expect(availableVariable(undefined, ["5"], false)).toBeUndefined();
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
      maxFixRounds: undefined,
      timeoutMinutes: undefined,
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
      maxFixRounds: undefined,
      timeoutMinutes: undefined,
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
   * A label the loop retired (#236) breaks nothing by being there, so it is a
   * thing to know rather than a failure: named, with the command that deletes
   * it, and the reason `init` may have left it.
   */
  it("reports a retired label still present as advisory, with the delete command", async () => {
    const { code, out, err } = await check(await installed(), {
      ...healthy(),
      labels: [...(healthy().labels ?? []), "agent:in-progress"],
    });

    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("warn  retired labels:");
    expect(out).toContain("agent:in-progress");
    expect(out).toContain('gh label delete "agent:in-progress" --yes');
  });

  it("says nothing about retired labels where none is present", async () => {
    const { out } = await check(await installed(), healthy());

    expect(out).not.toContain("retired labels");
  });

  /**
   * The same reasoning as every runner's `fail()`: a doctor run that is part of
   * a workflow has to leave its reason somewhere the `if: failure()` step can
   * put in front of a human.
   */
  it("writes its reasons where a workflow can read them", async () => {
    const root = await installed();
    edit(root, "fix", (text) => text.replace(/^ *packages: read$/m, ""));

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

/**
 * `docs/ADOPTING.md` says what `doctor` checks in one place, §0's table, and
 * says it by linking each row to the §1 failure it is for, by heading. A number
 * is what drifted: #230 put a new failure at the head of §1, and every reference that
 * counted moved by one while still reading as right.
 *
 * So the rules below are over the document as written, and each is shown
 * failing on a copy broken the one way it guards against. The first is the
 * point: whoever adds a failure to §1 decides whether `doctor` can check it,
 * and writes down either the row that links it or the reason it cannot. Both
 * is as wrong as neither.
 */
describe("docs/ADOPTING.md links each doctor check to the §1 failure it is for", () => {
  const ADOPTING = path.join("docs", "ADOPTING.md");
  const CANNOT_CHECK = "**`doctor` cannot check this.**";
  const TABLE_HEADER = /^\| What it checks \| The failure it is for \|$/m;

  /**
   * GitHub's heading anchor: lower case, every character that is not a letter,
   * a mark, a digit, an underscore, a hyphen or a space dropped (so the
   * backticks, quotes and asterisks in §1's headings go), spaces made hyphens,
   * and a repeat numbered from `-1` in document order, over the whole document.
   */
  const anchorsOf = (doc: string): { level: number; text: string; anchor: string }[] => {
    const seen = new Map<string, number>();
    return doc
      .replace(/^```[\s\S]*?^```/gm, "")
      .split("\n")
      .flatMap((line) => {
        const heading = /^(#{1,6}) +(.+?) *$/.exec(line);
        if (heading === null) return [];
        const [, hashes = "", text = ""] = heading;
        const base = text
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
          .replace(/ /g, "-");
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return [{ level: hashes.length, text, anchor: count === 0 ? base : `${base}-${count}` }];
      });
  };

  /** The section a `## ` heading starting with `prefix` opens, up to the next `## `. */
  const section = (doc: string, prefix: string): string =>
    doc.split(/^(?=## )/m).find((part) => part.startsWith(`## ${prefix}`)) ?? "";

  /** A Markdown link's text and target. */
  const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;

  /**
   * A §1 failure named by its position rather than its heading, in each place
   * a position can stand beside `§1`: an ordinal after `§1's`; a number after
   * `§1's failures` or `§1 failures`; an ordinal before `of §1` or `in §1`; an
   * ordinal before `§1 failure`, as its adjective; or a number after `failure`
   * before `of §1` or `in §1`. A count ("three of" the section's failures,
   * "every" one, "the three" of them) names no position and is left alone.
   */
  const ORDINAL =
    "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|penultimate|final|last";
  const NUMBER = "one|two|three|four|five|six|seven|eight|nine|ten|\\d+";
  const NUMBERED = new RegExp(
    [
      `§1['’]s\\s+(?:(?:silent\\s+)?failures?\\s+)?(?:${ORDINAL})\\b`,
      `§1(?:['’]s)?\\s+(?:silent\\s+)?failures?\\s+(?:${NUMBER})\\b`,
      `\\b(?:${ORDINAL})\\b(?:\\s+\\S+)?\\s+(?:(?:silent\\s+)?failures?\\s+)?(?:of|in)\\s+§1(?![0-9])`,
      `\\b(?:${ORDINAL})\\s+(?:\\S+\\s+)?§1\\s+(?:silent\\s+)?failures?\\b`,
      `\\bfailures?\\s+(?:${NUMBER})\\s+(?:of|in)\\s+§1(?![0-9])`,
    ].join("|"),
    "gi",
  );

  const numberedReferences = (text: string): string[] =>
    [...text.matchAll(NUMBERED)].map(([match]) => match.replace(/\s+/g, " "));

  /** Every way the document breaks the rules, as a sentence each; none is the pass. */
  const breaks = (doc: string): string[] => {
    const found: string[] = [];
    const anchors = anchorsOf(doc);

    const failures = anchorsOf(section(doc, "1."))
      .filter((heading) => heading.level === 3)
      .map((heading) => {
        const match = anchors.find((candidate) => candidate.level === 3 && candidate.text === heading.text);
        const body = section(doc, "1.").split(/^(?=### )/m).find((part) => part.startsWith(`### ${heading.text}\n`)) ?? "";
        return { text: heading.text, anchor: match?.anchor ?? "", marked: body.includes(CANNOT_CHECK) };
      });
    if (failures.length === 0) found.push("§1 has no ### failure under it");

    const zero = section(doc, "0.");
    const header = TABLE_HEADER.exec(zero);
    const rows =
      header === null
        ? []
        : zero
            .slice(header.index)
            .split("\n")
            .slice(2)
            .filter((_, at, lines) => lines.slice(0, at + 1).every((line) => line.startsWith("|")));
    if (rows.length === 0) found.push("§0 has no table of what doctor checks");

    const linked = new Set<string>();
    const sectionOne = new Set(failures.map((failure) => failure.anchor));
    for (const row of rows) {
      for (const [, , target = ""] of row.matchAll(LINK)) {
        if (!target.startsWith("#")) continue;
        const anchor = target.slice(1);
        linked.add(anchor);
        if (!sectionOne.has(anchor)) found.push(`§0's table links #${anchor}, which is no §1 heading`);
      }
      const forColumn = row.split(/(?<!\\)\|/)[2] ?? "";
      if (/§1(?![0-9])/.test(forColumn.replace(LINK, ""))) {
        found.push(`§0's table names §1 outside a link: ${forColumn.trim()}`);
      }
    }

    for (const failure of failures) {
      const isLinked = linked.has(failure.anchor);
      if (!isLinked && !failure.marked) {
        found.push(`${failure.text}: linked by no row of §0's table, and does not say doctor cannot check it`);
      }
      if (isLinked && failure.marked) {
        found.push(`${failure.text}: linked from §0's table, and says doctor cannot check it`);
      }
    }

    for (const reference of numberedReferences(doc)) found.push(`a §1 failure by number: ${reference}`);
    return found;
  };

  const doc = (): string => fs.readFileSync(ADOPTING, "utf8");

  it("holds on the document as written", () => {
    expect(breaks(doc())).toEqual([]);
  });

  /**
   * The same rules over copies broken one way each. A rule that cannot fail is
   * not one, and the first rule has two directions, both of which must.
   */
  it.each<[string, (text: string) => string, RegExp]>([
    [
      "a new §1 failure that is linked by no row and does not say doctor cannot check it",
      (text) => text.replace(/^## 2\. /m, "### A new failure\n\nNothing checks it.\n\n## 2. "),
      /^A new failure: linked by no row of §0's table, and does not say doctor cannot check it$/,
    ],
    [
      "a §1 failure that is linked and says doctor cannot check it",
      (text) =>
        text.replace(
          /^(### "GitHub Actions is not permitted to create or approve pull requests"\n)/m,
          `$1\n${CANNOT_CHECK} Nothing records it.\n`,
        ),
      /^"GitHub Actions is not permitted to create or approve pull requests": linked from §0's table, and says doctor cannot check it$/,
    ],
    [
      "an event failure that has lost its line",
      (text) => text.replace(new RegExp(`^${CANNOT_CHECK.replace(/[.*`]/g, "\\$&")}.*\\n`, "m"), ""),
      /^A label set when the issue is \*created\* fires no `labeled` event: linked by no row of §0's table, and does not say doctor cannot check it$/,
    ],
    [
      "a link in §0's table to an anchor that is no §1 heading",
      (text) => text.replace("](#on-a-public-repository-pull_request_target-stops-running)", "](#keeping-the-pins-fresh)"),
      /^§0's table links #keeping-the-pins-fresh, which is no §1 heading$/,
    ],
    [
      "§1 named outside a link in the failure column",
      (text) => text.replace("unless the App or `AGENT_PAT` makes it moot |", "unless the App or `AGENT_PAT` makes it moot (§1) |"),
      /^§0's table names §1 outside a link: /,
    ],
  ])("fails on %s", (_case, breakIt, expected) => {
    const broken = breakIt(doc());

    expect(broken, "the copy is not broken: the text it edits has moved").not.toBe(doc());
    expect(breaks(broken)).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
  });

  /**
   * Spelled through a constant, so this file names no §1 failure by number
   * itself and the scan below need not skip it.
   */
  const ONE = "§1";

  it.each([
    `${ONE}'s first, unless the App makes it moot`,
    `${ONE}'s last two`,
    `${ONE}'s fifth silent failure`,
    `${ONE}'s failures two, three and four`,
    `${ONE}'s second, third and fourth\nfailures`,
    `the first failure in ${ONE}`,
    `the last two of ${ONE}'s failures`,
    `the first ${ONE} failure`,
    `the last two ${ONE} failures`,
    `the third silent ${ONE} failure`,
    `${ONE} failures two and three`,
    `failure two of ${ONE}`,
    `failure 3 in ${ONE}`,
  ])("reads %j as a §1 failure by number", (text) => {
    expect(numberedReferences(text)).not.toEqual([]);
  });

  it.each([
    `three of ${ONE}'s failures at once`,
    `every ${ONE} failure`,
    `${ONE}'s failures`,
    `${ONE}0's first`,
    `all three failures in ${ONE}`,
    `the three ${ONE} failures`,
    `the first ${ONE}0 failure`,
    `failure two of ${ONE}0`,
  ])(
    "reads %j as no number",
    (text) => {
      expect(numberedReferences(text)).toEqual([]);
    },
  );

  /**
   * Everywhere, not only in the document. `docs/friction.md` is the one file
   * excused: it is a dated log, appended to and never rewritten to match today.
   */
  it("finds no §1 failure named by number in any tracked file but the friction log", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT })
      .split("\0")
      .filter((file) => file !== "" && file !== "docs/friction.md" && fs.existsSync(file));

    const offenders = tracked.flatMap((file) =>
      numberedReferences(fs.readFileSync(file, "utf8")).map((reference) => `${file}: ${reference}`),
    );

    expect(tracked).toContain(ADOPTING.split(path.sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
