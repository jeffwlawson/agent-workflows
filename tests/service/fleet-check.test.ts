import { describe, expect, it } from "vitest";
import { SERVICE_APP_PERMISSIONS, SERVICE_LABEL_SPECS } from "../../service/dispatcher.js";
import {
  checkFleet,
  FLEET_PERMISSIONS,
  fleetFindings,
  type FleetFacts,
  type FleetGitHub,
  type RepositoryEntry,
} from "../../service/fleet-check.js";
import { callersIn } from "../../setup/callers.js";
import { diagnose, type RepoFacts } from "../../setup/doctor.js";
import { PACKAGE_NAME } from "../../shared/manifest.js";

/**
 * The fleet check (#825), over a fake GitHub holding several installations
 * and their repositories. The fake records every call made of it and every
 * token minted, and holds no method that writes, so a write the check made
 * would fail typechecking before it failed here.
 */

const SLUG = PACKAGE_NAME.replace(/^@/, "");

/** A caller file calling review.yml at `ref`, as an adopter's would. */
const caller = (ref: string): string =>
  ["on:", "  pull_request_target:", "jobs:", "  review:", `    uses: ${SLUG}/.github/workflows/review.yml@${ref}`, ""].join("\n");

interface FakeRepository {
  readonly variables?: Readonly<Record<string, string>>;
  readonly labels?: readonly string[];
  /** Each file on the default branch, by its path. */
  readonly files?: Readonly<Record<string, string>>;
  /** Where set, every read of the repository fails with this. */
  readonly failing?: string;
}

interface World {
  readonly owner: string;
  /** Each installation's account, to its repositories by name. */
  readonly installations: Readonly<Record<string, Readonly<Record<string, FakeRepository>>>>;
  /** An installation whose repositories cannot be listed. */
  readonly unlisted?: string;
}

const ALL_LABELS = SERVICE_LABEL_SPECS.map((label) => label.name);

/** A repository on the service that the check passes: every variable set, every label, `CONTEXT.md`, no caller. */
const CLEAN: FakeRepository = {
  variables: { AGENT_ORCHESTRATOR: "service", AGENT_SETUP: "npm ci", AGENT_VERIFY: "npm run verify" },
  labels: ALL_LABELS,
  files: { "CONTEXT.md": "# Context\n" },
};

const fake = (world: World) => {
  const calls: string[] = [];
  const minted: Readonly<Record<string, string>>[] = [];
  const tokens = new Map<string, string>();
  const repository = (repo: string): FakeRepository => {
    const [account = "", name = ""] = repo.split("/");
    const found = world.installations[account]?.[name];
    if (found === undefined) throw new Error(`the fake holds no ${repo}`);
    if (found.failing !== undefined) throw new Error(found.failing);
    return found;
  };
  const token = (repo: string, held: string): void => {
    if (tokens.get(held) !== repo) throw new Error(`a token for ${tokens.get(held) ?? "nothing"} was used on ${repo}`);
  };
  const github: FleetGitHub = {
    app: async () => {
      calls.push("app");
      return { slug: "loop-app", owner: world.owner, permissions: SERVICE_APP_PERMISSIONS, events: [] };
    },
    installations: async () => {
      calls.push("installations");
      return Object.keys(world.installations);
    },
    repositories: async (account) => {
      calls.push(`repositories ${account}`);
      if (account === world.unlisted) throw new Error("listing them answered 502");
      return Object.keys(world.installations[account] ?? {}).map((name) => `${account}/${name}`);
    },
    mint: async (repo, permissions) => {
      calls.push(`mint ${repo}`);
      minted.push(permissions);
      const held = `ghs_${repo}`;
      tokens.set(held, repo);
      return { token: held, expiresAt: "2099-01-01T00:00:00Z" };
    },
    variableWith: async (repo, name, held) => {
      calls.push(`variable ${repo} ${name}`);
      token(repo, held);
      return repository(repo).variables?.[name];
    },
    labelsWith: async (repo, held) => {
      calls.push(`labels ${repo}`);
      token(repo, held);
      return repository(repo).labels ?? [];
    },
    entriesWith: async (repo, dir, held) => {
      calls.push(`entries ${repo} ${dir}`);
      token(repo, held);
      const paths = Object.keys(repository(repo).files ?? {});
      const prefix = dir === "" ? "" : `${dir}/`;
      const inside = paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
      if (dir !== "" && inside.length === 0) return undefined;
      const entries = new Map<string, RepositoryEntry>();
      for (const rest of inside) {
        const [first = "", ...deeper] = rest.split("/");
        entries.set(first, { name: first, type: deeper.length === 0 ? "file" : "dir" });
      }
      return [...entries.values()];
    },
    fileWith: async (repo, file, held) => {
      calls.push(`file ${repo} ${file}`);
      token(repo, held);
      const text = repository(repo).files?.[file];
      if (text === undefined) throw new Error(`reading ${file} answered 404`);
      return text;
    },
  };
  return { github, calls, minted };
};

const run = async (world: World, extraOwners: readonly string[] = []) => {
  const { github, calls, minted } = fake(world);
  let out = "";
  const code = await checkFleet({ github, extraOwners, stdout: (text) => (out += text) });
  return { code, out, lines: out.split("\n"), calls, minted };
};

/** The lines that start a repository's or an installation's report, the findings below them left out. */
const heads = (lines: readonly string[]): string[] => lines.filter((line) => line !== "" && !line.startsWith(" ") && !line.endsWith("."));

describe("the fleet check lists every repository the dispatcher serves (#825)", () => {
  const WORLD: World = {
    owner: "Owner",
    installations: {
      owner: {
        clean: CLEAN,
        actions: { variables: {} },
        typo: { variables: { AGENT_ORCHESTRATOR: "servce" } },
      },
      friend: {
        broken: {
          variables: { AGENT_ORCHESTRATOR: "service" },
          labels: ALL_LABELS.filter((name) => name !== "agent:setup-check"),
          files: { "CONTEXT.md": "", ".github/workflows/pr.yml": caller("v0.8.0") },
        },
      },
      stranger: { theirs: CLEAN },
    },
  };

  it("checks each one on the service, gives each other one line, and leaves an account it does not serve unchecked", async () => {
    const { code, lines, calls } = await run(WORLD, ["friend"]);

    expect(heads(lines)).toEqual([
      "owner/clean: ok",
      "owner/actions: not on the service: AGENT_ORCHESTRATOR is unset, not `service`",
      "owner/typo: not on the service: AGENT_ORCHESTRATOR is `servce`, not `service`",
      "friend/broken: 2 error(s), 0 warning(s)",
      "stranger: not served, since it is neither the App's owner nor an account EXTRA_OWNERS lists, so its repositories are not checked",
    ]);
    expect(calls).not.toContain("repositories stranger");
    // A repository not on the service is read for its opt-in and nothing more.
    expect(calls.filter((call) => call.includes("owner/actions"))).toEqual(["mint owner/actions", "variable owner/actions AGENT_ORCHESTRATOR"]);
    expect(code).toBe(1);
  });

  it("puts each finding of a repository indented below its line, errors first", async () => {
    const { out } = await run(WORLD, ["friend"]);
    const broken = out.slice(out.indexOf("friend/broken:"), out.indexOf("stranger:"));

    expect(broken).toMatch(/^friend\/broken: 2 error\(s\), 0 warning\(s\)\n {4}FAIL {2}service guard: \.github\/workflows\/pr\.yml is pinned to `@v0\.8\.0`/);
    expect(broken).toContain("    FAIL  labels: agent:setup-check does not exist.");
    expect(broken.indexOf("FAIL")).toBeLessThan(broken.indexOf("note"));
    for (const line of broken.split("\n").slice(1).filter(Boolean)) expect(line).toMatch(/^ {4}/);
  });

  it("exits 0 where every repository was read and none has an error", async () => {
    const { code, out } = await run({ owner: "owner", installations: { owner: { clean: CLEAN, actions: {} } } });

    expect(code).toBe(0);
    expect(out).toContain("2 repository(ies) checked; no error, and every one read.");
  });

  it("matches an account to the App's owner and to EXTRA_OWNERS without regard to case", async () => {
    const { lines } = await run({ owner: "OWNER", installations: { owner: { clean: CLEAN }, Friend: { clean: CLEAN } } }, ["friend"]);

    expect(heads(lines)).toEqual(["owner/clean: ok", "Friend/clean: ok"]);
  });
});

describe("the fleet check's findings are doctor's, for the same facts (#825)", () => {
  const callers = callersIn(caller("v0.8.0"), PACKAGE_NAME, ".github/workflows/pr.yml");
  const facts = (known: Partial<RepoFacts>): RepoFacts => ({
    secrets: undefined,
    canCreatePullRequests: undefined,
    defaultWorkflowPermissions: undefined,
    labels: undefined,
    visibility: undefined,
    actionsPolicies: undefined,
    releases: undefined,
    maxFixRounds: undefined,
    fixMinSeverity: undefined,
    timeoutMinutes: undefined,
    orchestrator: "service",
    agentSetup: "npm ci",
    domainModel: { context: false, glossaries: ["GLOSSARY.md"] },
    ...known,
  });

  it.each([
    ["every label, an old caller and a renamed domain model", facts({ labels: ALL_LABELS })],
    ["a missing label and a retired one", facts({ labels: [...ALL_LABELS.slice(1), "agent:in-progress"] })],
    ["unreadable labels", facts({})],
    ["no setup, with a caller passing one", facts({ labels: ALL_LABELS, agentSetup: null })],
  ])("%s: doctor's findings, the `service App` note answered and the missing labels' fix naming the scan first", (_, given) => {
    const read: FleetFacts = { callers, facts: given, verify: "npm run verify" };
    const doctor = diagnose(callers, given);
    const fleet = fleetFindings(read);

    const expected = doctor
      .filter((finding) => finding.check !== "service App")
      .map((finding) =>
        finding.check === "labels" && finding.severity === "error"
          ? { ...finding, fix: expect.stringMatching(/^The dispatcher's next scan creates them/) as unknown as string }
          : finding,
      );
    const added = fleet.filter((finding) => finding.check === "service setup");
    expect(fleet).toEqual([...expected, ...added]);
    for (const finding of fleet.filter((finding) => finding.check === "labels" && finding.severity === "error")) {
      const own = doctor.find((mine) => mine.check === "labels" && mine.severity === "error");
      expect(finding.fix.endsWith(own?.fix ?? "no such finding")).toBe(true);
    }
  });
});

describe("the fleet check's notes and findings for the service (#825)", () => {
  const facts: RepoFacts = {
    secrets: undefined,
    canCreatePullRequests: undefined,
    defaultWorkflowPermissions: undefined,
    labels: ALL_LABELS,
    visibility: undefined,
    actionsPolicies: undefined,
    releases: undefined,
    maxFixRounds: undefined,
    fixMinSeverity: undefined,
    timeoutMinutes: undefined,
    orchestrator: "service",
    agentSetup: "npm ci",
    domainModel: { context: true, glossaries: [] },
  };

  it("notes an unset AGENT_SETUP", () => {
    const notes = fleetFindings({ callers: [], facts: { ...facts, agentSetup: null }, verify: "npm run verify" }).filter((f) => f.check === "service setup");

    expect(notes).toEqual([expect.objectContaining({ severity: "note", problem: expect.stringContaining("`AGENT_SETUP` is unset") as unknown })]);
  });

  it("notes an unset AGENT_VERIFY, naming the setup check as what reads it", () => {
    const notes = fleetFindings({ callers: [], facts, verify: null }).filter((f) => f.check === "verify command");

    expect(notes).toHaveLength(1);
    expect(notes[0]?.severity).toBe("note");
    expect(notes[0]?.problem).toContain("`AGENT_VERIFY` is unset");
    expect(notes[0]?.problem).toContain("`agent:setup-check`");
  });

  it("adds neither note where both are set", () => {
    expect(fleetFindings({ callers: [], facts, verify: "npm run verify" }).map((f) => f.check)).toEqual(["orchestrator"]);
  });

  it("finds a missing trigger label, and says the dispatcher's next scan creates it", () => {
    const [finding] = fleetFindings({ callers: [], facts: { ...facts, labels: ALL_LABELS.filter((name) => name !== "agent:review") }, verify: "v" }).filter(
      (f) => f.check === "labels",
    );

    expect(finding?.severity).toBe("error");
    expect(finding?.problem).toContain("agent:review does not exist");
    expect(finding?.fix).toMatch(/^The dispatcher's next scan creates them/);
  });

  it("reports the setup and verify notes in a repository's lines", async () => {
    const { out } = await run({
      owner: "owner",
      installations: { owner: { bare: { variables: { AGENT_ORCHESTRATOR: "service" }, labels: ALL_LABELS, files: { "CONTEXT.md": "" } } } },
    });

    expect(out).toContain("owner/bare: ok\n");
    expect(out).toContain("    note  service setup: The repository variable `AGENT_SETUP` is unset");
    expect(out).toContain("    note  verify command: The repository variable `AGENT_VERIFY` is unset");
  });
});

describe("the fleet check reads, and reads only (#825)", () => {
  const WORLD: World = {
    owner: "owner",
    installations: {
      owner: {
        clean: { ...CLEAN, files: { ...CLEAN.files, ".github/workflows/pr.yml": caller("v0.9.19"), ".github/workflows/notes.txt": "" } },
        actions: {},
      },
    },
  };

  it("asks every token it mints for read permissions alone, FLEET_PERMISSIONS, one for each repository", async () => {
    const { minted } = await run(WORLD);

    expect(minted).toEqual([FLEET_PERMISSIONS, FLEET_PERMISSIONS]);
    for (const access of Object.values(FLEET_PERMISSIONS)) expect(access).toBe("read");
  });

  it("asks for permissions the App already holds for the dispatcher", () => {
    for (const [name, access] of Object.entries(FLEET_PERMISSIONS)) expect(SERVICE_APP_PERMISSIONS).toHaveProperty(name, expect.stringMatching(/^(read|write)$/));
    expect(Object.keys(FLEET_PERMISSIONS).every((name) => name in SERVICE_APP_PERMISSIONS)).toBe(true);
  });

  it("makes no request but the reads, and reads each caller file", async () => {
    const { calls } = await run(WORLD);
    const kinds = new Set(calls.map((call) => call.split(" ")[0]));

    expect([...kinds].sort()).toEqual(["app", "entries", "file", "installations", "labels", "mint", "repositories", "variable"]);
    expect(calls).toContain("file owner/clean .github/workflows/pr.yml");
    expect(calls).not.toContain("file owner/clean .github/workflows/notes.txt");
  });
});

describe("the fleet check with a repository it cannot read (#825)", () => {
  it("reports it by name with the reason, checks the rest, and exits 1", async () => {
    const { code, lines } = await run({
      owner: "owner",
      installations: {
        owner: { first: CLEAN, refused: { failing: "reading AGENT_ORCHESTRATOR on owner/refused answered 403" }, last: CLEAN },
      },
    });

    expect(heads(lines)).toEqual(["owner/first: ok", "owner/refused: could not be read: reading AGENT_ORCHESTRATOR on owner/refused answered 403", "owner/last: ok"]);
    expect(code).toBe(1);
  });

  it("reports an installation whose repositories cannot be listed, checks the others, and exits 1", async () => {
    const { code, lines } = await run({ owner: "owner", installations: { owner: { clean: CLEAN }, friend: { clean: CLEAN } }, unlisted: "owner" }, ["friend"]);

    expect(heads(lines)).toEqual(["owner: could not be read: its repositories could not be listed: listing them answered 502", "friend/clean: ok"]);
    expect(code).toBe(1);
  });
});
