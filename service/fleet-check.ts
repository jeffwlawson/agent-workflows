import * as fs from "node:fs";
import { callersIn, type InstalledCaller } from "../setup/callers.js";
import { diagnose, domainModelOf, render, SETUP_VARIABLE, type Finding, type RepoFacts } from "../setup/doctor.js";
import { commonWriters } from "../shared/common.js";
import type { InputValues } from "../shared/env.js";
import { PACKAGE_NAME } from "../shared/manifest.js";
import { WORKFLOW_DIR } from "../shared/pins.js";
import { ORCHESTRATOR_VARIABLE, SERVICE_ORCHESTRATOR, SETUP_CHECK_LABEL } from "../shared/record.js";
import { foreignAccount, parseOwners, type AppGitHub } from "./dispatcher.js";
import { liveAppGitHub } from "./github-app.js";
import type { FLEET_CHECK } from "./settings.js";

/**
 * **The fleet check** (#825): `doctor` for every repository the service
 * serves, run by a person on the dispatcher's host, with the App's own
 * tokens. One box upgrade upgrades every repository at once (ADR 0012), so
 * after one this is what checks them as a set.
 *
 * It lists every installation the dispatcher serves, the App's owner's and
 * the ones `EXTRA_OWNERS` lists, and every repository of each. A repository
 * whose `AGENT_ORCHESTRATOR` is not `service` gets one line saying so. One
 * that is gets `doctor`'s own ruling, `diagnose`, on facts read through the
 * App's API rather than a checkout and `gh`, so the rules are `doctor`'s and
 * not a copy of them, and then the few the service adds (`fleetFindings`).
 *
 * Read-only: every token it mints asks for `FLEET_PERMISSIONS` alone, and
 * every request it makes is a read. Every check `diagnose` makes of a
 * repository on the service is answered by what that token reads (its
 * variables, its labels and its files), so none is skipped; the Actions-only
 * checks are not run on the service, as `doctor` itself says in its
 * `orchestrator` note.
 */

/**
 * The permissions each repository's token asks for, and the fewest that
 * answer the checks: metadata for the repository's owner (where an
 * organization variable is read), its variables, its labels (which GitHub
 * serves with Issues: read) and its files (the callers and the root's
 * listing). Each is one `SERVICE_APP_PERMISSIONS` already holds.
 */
export const FLEET_PERMISSIONS: Readonly<Record<string, string>> = {
  metadata: "read",
  actions_variables: "read",
  issues: "read",
  contents: "read",
};

/** The repository variable the setup check reads its verify command from (#821). */
export const VERIFY_VARIABLE = "AGENT_VERIFY";

/** One entry of a folder, as the contents API lists it: `file`, `dir`, `symlink` or `submodule`. */
export interface RepositoryEntry {
  readonly name: string;
  readonly type: string;
}

/**
 * What the fleet check asks of GitHub, as the App: its record, its
 * installations and their repositories, and a token per repository, which
 * each read below is handed. Every one of them is a read but the mint.
 */
export interface FleetGitHub extends Pick<AppGitHub, "app" | "installations" | "repositories" | "mint"> {
  /** A variable's value as `vars` resolves it for `repo`, or `undefined` where it is set nowhere. Throws where it could not be read. */
  variableWith(repo: string, name: string, token: string): Promise<string | undefined>;
  /** The name of every label `repo` holds. */
  labelsWith(repo: string, token: string): Promise<readonly string[]>;
  /** The entries of folder `dir` on `repo`'s default branch, `""` the root, or `undefined` where there is no such folder. */
  entriesWith(repo: string, dir: string, token: string): Promise<readonly RepositoryEntry[] | undefined>;
  /** The text of `file` on `repo`'s default branch. */
  fileWith(repo: string, file: string, token: string): Promise<string>;
}

/**
 * What the fleet check reads of one repository on the service: `doctor`'s
 * facts, those the service's side can answer and the rest unknown, its
 * callers, and the verify command, which `doctor` does not read.
 */
export interface FleetFacts {
  readonly callers: readonly InstalledCaller[];
  readonly facts: RepoFacts;
  /** `AGENT_VERIFY`'s value, or `null` where it is set nowhere. */
  readonly verify: string | null;
}

const unset = (value: string | null | undefined): boolean => value === null || value === undefined || value === "";

/**
 * `diagnose`'s findings, as the service's side reads them. Two are worded
 * for a person at a checkout and are turned to the service's: the `service
 * App` note, that `doctor` cannot tell whether the App is installed, is
 * answered here, since the repository was reached through the App's
 * installation; and the labels found missing are labels the dispatcher
 * creates at its next scan (#823), so the fix says so first.
 */
const fromTheService = (finding: Finding): readonly Finding[] => {
  if (finding.check === "service App") return [];
  if (finding.check === "labels" && finding.severity === "error") {
    return [
      {
        ...finding,
        fix:
          `The dispatcher's next scan creates them: it converges the loop's labels on every repository it ` +
          `serves, at its start and every SCAN_INTERVAL_MINUTES, so restarting it scans now. By hand:\n       ${finding.fix}`,
      },
    ];
  }
  return [finding];
};

/**
 * Rule on one repository on the service: `doctor`'s `diagnose`, through
 * `fromTheService`, and the two notes the service adds, on the variables
 * only its jobs read.
 */
export const fleetFindings = ({ callers, facts, verify }: FleetFacts, packageName: string = PACKAGE_NAME): readonly Finding[] => {
  const findings = diagnose(callers, facts, packageName).flatMap(fromTheService);
  const notes: Finding[] = [];
  if (unset(facts.agentSetup)) {
    notes.push({
      severity: "note",
      check: "service setup",
      problem:
        `The repository variable \`${SETUP_VARIABLE}\` is ${facts.agentSetup === "" ? "empty" : "unset"}, so the service runs no ` +
        `setup before this repository's agents: each starts with what the box has, and a \`mise.toml\`'s tools.`,
      fix:
        `Nothing to fix where the repository needs no install. Otherwise set \`${SETUP_VARIABLE}\` to it ` +
        `(docs/deploying-the-service.md#the-repositorys-setup).`,
    });
  }
  if (unset(verify)) {
    notes.push({
      severity: "note",
      check: "verify command",
      problem:
        `The repository variable \`${VERIFY_VARIABLE}\` is ${verify === "" ? "empty" : "unset"}. Only the setup check, ` +
        `\`${SETUP_CHECK_LABEL}\`, reads it, and without it a check stops after the setup and runs no verify command.`,
      fix:
        `Set \`${VERIFY_VARIABLE}\` to the verify command the repository's \`CLAUDE.md\` names ` +
        `(docs/deploying-the-service.md#the-setup-check).`,
    });
  }
  return [...findings, ...notes];
};

/** `doctor`'s facts with every one the service's side does not read left unknown. */
const serviceFacts = (known: Pick<RepoFacts, "orchestrator" | "agentSetup" | "labels" | "domainModel">): RepoFacts => ({
  secrets: undefined,
  canCreatePullRequests: undefined,
  defaultWorkflowPermissions: undefined,
  visibility: undefined,
  actionsPolicies: undefined,
  releases: undefined,
  maxFixRounds: undefined,
  fixMinSeverity: undefined,
  timeoutMinutes: undefined,
  ...known,
});

/** What one repository's reads came to: not on the service, or the facts to rule on. */
type Read = { readonly onService: false; readonly orchestrator: string | undefined } | ({ readonly onService: true } & FleetFacts);

/** Read `repo`'s facts with one token, minted for it alone with `FLEET_PERMISSIONS`. Throws where a read fails. */
const readRepository = async (github: FleetGitHub, repo: string, packageName: string): Promise<Read> => {
  const { token } = await github.mint(repo, FLEET_PERMISSIONS);
  const orchestrator = await github.variableWith(repo, ORCHESTRATOR_VARIABLE, token);
  if (orchestrator !== SERVICE_ORCHESTRATOR) return { onService: false, orchestrator };
  const agentSetup = (await github.variableWith(repo, SETUP_VARIABLE, token)) ?? null;
  const verify = (await github.variableWith(repo, VERIFY_VARIABLE, token)) ?? null;
  const labels = await github.labelsWith(repo, token);
  // An empty repository has no root to list, which is no file at all.
  const root = (await github.entriesWith(repo, "", token)) ?? [];
  const files = new Set(root.filter((entry) => entry.type === "file" || entry.type === "symlink").map((entry) => entry.name));
  // The callers as `doctor` finds them in a checkout: every `.yml` and `.yaml` file there, in filename order.
  const workflows = ((await github.entriesWith(repo, WORKFLOW_DIR, token)) ?? [])
    .filter((entry) => entry.type === "file" && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => entry.name)
    .sort();
  const callers: InstalledCaller[] = [];
  for (const name of workflows) {
    const file = `${WORKFLOW_DIR}/${name}`;
    callers.push(...callersIn(await github.fileWith(repo, file, token), packageName, file));
  }
  return {
    onService: true,
    callers,
    verify,
    facts: serviceFacts({ orchestrator, agentSetup, labels, domainModel: domainModelOf(files) }),
  };
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const indent = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => `    ${line}`)
    .join("\n");

const ORDER = { error: 0, warning: 1, note: 2 } as const;

export interface FleetEdges {
  readonly github: FleetGitHub;
  /** The accounts `EXTRA_OWNERS` lists, whose installations are served beside the App owner's. */
  readonly extraOwners: readonly string[];
  /** Where each repository's lines go. */
  readonly stdout: (text: string) => void;
  readonly packageName?: string;
}

/**
 * Check every repository of every installation the dispatcher serves, and
 * return the exit code: `0` where every repository was read and none has an
 * error, `1` otherwise. A repository or an installation that could not be
 * read is a line naming it and why, and the rest are still checked. Throws
 * where the App's own record or its installations cannot be read, which
 * leaves nothing to check.
 */
export const checkFleet = async (edges: FleetEdges): Promise<number> => {
  const { github, stdout } = edges;
  const packageName = edges.packageName ?? PACKAGE_NAME;
  const owner = (await github.app()).owner;
  // The dispatcher's own rule for the accounts it serves, not a copy of it.
  const foreign = foreignAccount([owner, ...edges.extraOwners]);
  const accounts = await github.installations();
  let failed = false;
  let checked = 0;
  for (const account of accounts) {
    if (foreign(account) !== undefined) {
      stdout(`${account}: not served, since it is neither the App's owner nor an account EXTRA_OWNERS lists, so its repositories are not checked\n`);
      continue;
    }
    let repos: readonly string[];
    try {
      repos = await github.repositories(account);
    } catch (error) {
      failed = true;
      stdout(`${account}: could not be read: its repositories could not be listed: ${message(error)}\n`);
      continue;
    }
    for (const repo of repos) {
      checked += 1;
      let read: Read;
      try {
        read = await readRepository(github, repo, packageName);
      } catch (error) {
        failed = true;
        stdout(`${repo}: could not be read: ${message(error)}\n`);
        continue;
      }
      if (!read.onService) {
        stdout(
          `${repo}: not on the service: ${ORCHESTRATOR_VARIABLE} is ${read.orchestrator === undefined ? "unset" : `\`${read.orchestrator}\``}, not \`${SERVICE_ORCHESTRATOR}\`\n`,
        );
        continue;
      }
      const findings = [...fleetFindings(read, packageName)].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
      const errors = findings.filter((finding) => finding.severity === "error").length;
      const warnings = findings.filter((finding) => finding.severity === "warning").length;
      if (errors > 0) failed = true;
      stdout(`${repo}: ${errors === 0 && warnings === 0 ? "ok" : `${errors} error(s), ${warnings} warning(s)`}\n`);
      for (const finding of findings) stdout(`${indent(render(finding))}\n`);
    }
  }
  stdout(`\n${checked} repository(ies) checked; ${failed ? "see above for what failed or could not be read" : "no error, and every one read"}.\n`);
  return failed ? 1 : 0;
};

/**
 * The `fleet-check` subcommand: the dispatcher's own settings (the App's ID,
 * its key's file and `EXTRA_OWNERS`), read the way the dispatcher reads them,
 * and the live App behind `checkFleet`.
 */
export const runFleetCheck = async (settings: InputValues<typeof FLEET_CHECK>, stdout: (text: string) => void): Promise<number> => {
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(settings.GITHUB_APP_PRIVATE_KEY_FILE, "utf8");
  } catch (error) {
    throw new Error(`\`GITHUB_APP_PRIVATE_KEY_FILE\` names ${settings.GITHUB_APP_PRIVATE_KEY_FILE}, which could not be read: ${message(error)}`);
  }
  const github = liveAppGitHub(settings.GITHUB_APP_ID, privateKey);
  let code: number;
  try {
    code = await checkFleet({ github, extraOwners: parseOwners(settings.EXTRA_OWNERS), stdout });
  } catch (error) {
    throw new Error(`The fleet check could not list what the App serves: ${message(error)}`);
  }
  // A result rather than a crash, as `doctor`'s is; the lines above name each repository.
  if (code !== 0) commonWriters.writeText("failure_reason.txt", "The fleet check found an error in a repository, or one it could not read. Its output names each.");
  return code;
};
