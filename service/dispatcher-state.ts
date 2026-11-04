import * as fs from "node:fs";
import { JOB_KINDS, type JobKind } from "./job.js";

/**
 * **The dispatcher's state on disk** (#618): what the record cannot hold of
 * the dispatcher's own bookkeeping, kept in one small JSON file that
 * `STATE_FILE` names, so a restarted dispatcher keeps it. The scan's counts
 * (`asks`), so an item at the limit is not dispatched again and its comment is
 * not posted twice, and the jobs it dispatched (`jobs`), so a job the worker
 * is still running is answered at its next token request.
 *
 * It holds no secret: identifiers, counts, flags and dates only. No token, no
 * key, no signature, and no instance id, which is fresh at each start (#597).
 *
 * Written atomically: to a temporary file beside it, flushed, then renamed
 * over it, so a crash leaves the old file or the new one, never half of one.
 * Read once, at start. One dispatcher per file: two sharing one are not
 * supported, and nothing locks it.
 */

/** The file's format, which a file of any other is not read as. */
export const STATE_VERSION = 1;

/** A job the dispatcher dispatched, as its `jobs` map holds it, with its id. */
export interface StoredJob {
  readonly id: string;
  readonly repo: string;
  readonly deadline: Date;
  readonly workflow: JobKind;
  readonly number: number;
  readonly posted: boolean;
  readonly scanned: boolean;
  readonly order: number;
  /** The label a scan's dispatch of it is counted toward at its first token request (#600); absent where there is none, as in an older file. */
  readonly label?: string;
}

/** One item's label the scan counts, as its `asks` map holds it. */
export interface StoredAsk {
  readonly repo: string;
  readonly number: number;
  readonly label: string;
  readonly dispatches: number;
  readonly told: boolean;
  /** When a scan's dispatch was last counted, in milliseconds, which `waitsOnReset` reads. */
  readonly at?: number;
}

export interface DispatcherState {
  readonly jobs: readonly StoredJob[];
  readonly asks: readonly StoredAsk[];
}

export const EMPTY_STATE: DispatcherState = { jobs: [], asks: [] };

/** The file's text for `state`. */
export const serialiseState = (state: DispatcherState): string =>
  `${JSON.stringify(
    {
      version: STATE_VERSION,
      asks: state.asks.map(({ repo, number, label, dispatches, told, at }) => ({
        repo,
        number,
        label,
        dispatches,
        told,
        ...(at === undefined ? {} : { at: new Date(at).toISOString() }),
      })),
      jobs: state.jobs.map(({ id, repo, deadline, workflow, number, posted, scanned, order, label }) => ({
        id,
        repo,
        deadline: deadline.toISOString(),
        workflow,
        number,
        posted,
        scanned,
        order,
        ...(label === undefined ? {} : { label }),
      })),
    },
    null,
    2,
  )}\n`;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown, least: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= least;
const date = (value: unknown): Date | undefined => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value) : undefined);
const REPO = /^[\w.-]+\/[\w.-]+$/;

const parseAsk = (value: unknown, index: number): StoredAsk | string => {
  const where = `\`asks\` entry ${index + 1}`;
  if (!isObject(value)) return `${where} is not an object`;
  const { repo, number, label, dispatches, told, at } = value;
  if (typeof repo !== "string" || !REPO.test(repo)) return `${where}'s \`repo\` is not \`owner/name\``;
  if (!count(number, 1)) return `${where}'s \`number\` is not a positive integer`;
  if (typeof label !== "string" || label === "") return `${where}'s \`label\` is not a non-empty string`;
  if (!count(dispatches, 0)) return `${where}'s \`dispatches\` is not a whole number`;
  if (typeof told !== "boolean") return `${where}'s \`told\` is not true or false`;
  if (at === undefined) return { repo, number, label, dispatches, told };
  const when = date(at);
  if (when === undefined) return `${where}'s \`at\` is not a time`;
  return { repo, number, label, dispatches, told, at: when.getTime() };
};

const parseJob = (value: unknown, index: number): StoredJob | string => {
  const where = `\`jobs\` entry ${index + 1}`;
  if (!isObject(value)) return `${where} is not an object`;
  const { id, repo, deadline, workflow, number, posted, scanned, order, label } = value;
  if (typeof id !== "string" || id === "") return `${where}'s \`id\` is not a non-empty string`;
  if (typeof repo !== "string" || !REPO.test(repo)) return `${where}'s \`repo\` is not \`owner/name\``;
  const due = date(deadline);
  if (due === undefined) return `${where}'s \`deadline\` is not a time`;
  if (!JOB_KINDS.some((kind) => kind === workflow)) return `${where}'s \`workflow\` is not a kind this release runs`;
  if (!count(number, 1)) return `${where}'s \`number\` is not a positive integer`;
  if (typeof posted !== "boolean") return `${where}'s \`posted\` is not true or false`;
  if (typeof scanned !== "boolean") return `${where}'s \`scanned\` is not true or false`;
  if (!count(order, 1)) return `${where}'s \`order\` is not a positive integer`;
  const read = { id, repo, deadline: due, workflow: workflow as JobKind, number, posted, scanned, order };
  if (label === undefined) return read;
  if (typeof label !== "string" || label === "") return `${where}'s \`label\` is not a non-empty string`;
  return { ...read, label };
};

/** The state a file's text holds, or the reason it holds none. */
export const parseState = (text: string): DispatcherState | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "it is not JSON";
  }
  if (!isObject(value)) return "it is not an object";
  if (value["version"] !== STATE_VERSION) return `its \`version\` is ${JSON.stringify(value["version"])}, not ${STATE_VERSION}, the one this release reads`;
  const { asks, jobs } = value;
  if (!Array.isArray(asks)) return "its `asks` is not a list";
  if (!Array.isArray(jobs)) return "its `jobs` is not a list";
  const read: { asks: StoredAsk[]; jobs: StoredJob[] } = { asks: [], jobs: [] };
  for (const [index, entry] of (asks as unknown[]).entries()) {
    const ask = parseAsk(entry, index);
    if (typeof ask === "string") return ask;
    read.asks.push(ask);
  }
  for (const [index, entry] of (jobs as unknown[]).entries()) {
    const job = parseJob(entry, index);
    if (typeof job === "string") return job;
    read.jobs.push(job);
  }
  return read;
};

/** What the state file is read and written through: the file system, or a test's. */
export interface StateFiles {
  /** The file's text, or `undefined` where there is no file. Throws where it could not be read. */
  readonly read: (path: string) => string | undefined;
  /** Writes `text` to `path`, replacing it, and flushes it to the disk before answering. */
  readonly write: (path: string, text: string) => void;
  /** Renames `from` over `to`, in one step. */
  readonly rename: (from: string, to: string) => void;
  /** Removes `path`, where it is there. */
  readonly remove: (path: string) => void;
}

export const liveStateFiles: StateFiles = {
  read: (path) => {
    try {
      return fs.readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  write: (path, text) => {
    const fd = fs.openSync(path, "w", 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  rename: (from, to) => fs.renameSync(from, to),
  remove: (path) => fs.rmSync(path, { force: true }),
};

/** The dispatcher's state file, open: what it held at start, and how a change is written. */
export interface StateStore {
  readonly initial: DispatcherState;
  /** Writes `state` over the file, atomically. Throws, naming the file, where it could not be written. */
  readonly save: (state: DispatcherState) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Opens the state file `setting` names at `path`, at the dispatcher's start.
 * A file that cannot be read, is not valid, or has an unknown `version` is
 * logged, naming it and the reason, and the dispatcher starts empty. The file
 * is then written once, so a bad one is replaced, and a path that cannot be
 * written to is refused, naming the setting: a state file that silently does
 * not persist is what it is there to end.
 */
export const openState = (setting: string, path: string, files: StateFiles, log: (line: string) => void): StateStore => {
  const temporary = `${path}.tmp`;
  /** Writes `state` to the temporary file, then renames it over the file; a throw leaves the file as it was. */
  const write = (state: DispatcherState): void => {
    try {
      files.write(temporary, serialiseState(state));
      files.rename(temporary, path);
    } catch (error) {
      try {
        files.remove(temporary);
      } catch {
        // The write's own failure is the one to report.
      }
      throw error;
    }
  };
  const save = (state: DispatcherState): void => {
    try {
      write(state);
    } catch (error) {
      throw new Error(`the state file ${path} could not be written: ${message(error)}`);
    }
  };

  let initial = EMPTY_STATE;
  let text: string | undefined | null;
  try {
    text = files.read(path);
  } catch (error) {
    text = null;
    log(`state: ${path} could not be read: ${message(error)}. Starting empty; the next write replaces it`);
  }
  if (text === undefined) {
    log(`state: no file at ${path} yet; starting empty`);
  } else if (text !== null) {
    const parsed = parseState(text);
    if (typeof parsed === "string") log(`state: ${path} is not a state file this release reads: ${parsed}. Starting empty; the next write replaces it`);
    else {
      initial = parsed;
      log(`state: read ${path}: ${parsed.jobs.length} dispatched job(s), ${parsed.asks.length} scan count(s)`);
    }
  }
  try {
    write(initial);
  } catch (error) {
    throw new Error(`\`${setting}\` names ${path}, which cannot be written: ${message(error)}`);
  }
  return { initial, save };
};
