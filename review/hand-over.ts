/**
 * PROTOTYPE (#399), throwaway. The typed readers `review:publish` and
 * `review:conclude` read another subcommand's files through (ADR 0004, ADR
 * 0006): only the files the command declares, parsed strictly, the review's
 * commit checked against the gate's, and the agent's text handed out cleaned.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { COMMANDS, DirectoryInput } from "../shared/contract.js";
import { FIX_ROUND_STATUS, VERDICT_CONTEXT, type Verdict } from "../shared/review-output.js";
import type { ReviewInput } from "../engine/writer.js";

/** Text that came from the agent and has been through cleanup (#391). Only a reader makes one. */
export type Cleaned = string & { readonly __cleaned: unique symbol };

/** Cleanup itself is #391's. The prototype passes it in, so a test can show what it would do to the hand-over. */
export type Cleanup = (text: string) => string;
export const NO_CLEANUP: Cleanup = (text) => text;

export class HandOverError extends Error {}

export interface Directory<F extends string> {
  exists(name: F): boolean;
  text(name: F): string | undefined;
  json(name: F): unknown;
}

/** The files `review:publish` declares it reads from the review: any other name is a type error. */
export type PublishReads = (typeof COMMANDS)["review:publish"]["reads"]["REVIEW_DIR"]["files"][number];

/** The files a declaration names, and no others, in one directory. */
export const directory = <F extends string>(dir: string, declared: DirectoryInput<F>): Directory<F> => {
  const file = (name: F): string => path.join(dir, name);
  return {
    exists: (name: F): boolean => fs.existsSync(file(name)),
    text: (name: F): string | undefined => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : undefined),
    json: (name: F): unknown => {
      if (!fs.existsSync(file(name))) return undefined;
      try {
        return JSON.parse(fs.readFileSync(file(name), "utf8"));
      } catch (error) {
        throw new HandOverError(`${declared.producer}'s ${name} is not JSON: ${String(error)}`);
      }
    },
  };
};

const fail = (file: string, what: string): never => {
  throw new HandOverError(`review's ${file} ${what}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (file: string, value: unknown, field: string): string =>
  typeof value === "string" ? value : fail(file, `has no string \`${field}\``);

export interface ReviewHandOver {
  /** The variables of the review's request: never its query, which is the engine's. */
  readonly review: Omit<ReviewInput, "body">;
  readonly body: {
    readonly slotted: Cleaned;
    readonly slot: string;
    readonly resolved: readonly { readonly threadId?: string; readonly line: Cleaned }[];
    readonly groups: Readonly<Record<"resolved" | "unclosed", { readonly title: string; readonly open: boolean; readonly subtitle?: string }>>;
  };
  readonly verdict: Verdict;
  readonly status: { readonly state: "error" | "failure" | "pending" | "success"; readonly description: string };
  readonly fixRound: boolean;
  readonly resolutions: readonly { readonly threadId: string; readonly reason: "ADDRESSED" | "WONT_FIX"; readonly reply: Cleaned; readonly alreadyReplied: boolean }[];
  readonly followUps: boolean;
  readonly summary?: {
    readonly title?: Cleaned;
    readonly block?: { readonly start: string; readonly end: string; readonly inner: Cleaned };
    readonly drop?: { readonly start: string; readonly end: string };
  };
  readonly statusLine?: Cleaned;
}

const VERDICTS: readonly Verdict[] = ["approval recommended", "changes recommended", "needs a closer look"];
const STATES = ["error", "failure", "pending", "success"] as const;

/** `verdict.json` alone, which `review:conclude` reads as well. */
export const readVerdict = (raw: unknown): Pick<ReviewHandOver, "verdict" | "status" | "fixRound"> => {
  const file = "verdict.json";
  if (!isRecord(raw)) return fail(file, "is missing or not an object");
  // A choice (#403): parsed into a fixed set, and the context is the loop's own.
  if (raw["context"] !== VERDICT_CONTEXT) fail(file, `names context ${JSON.stringify(raw["context"])}`);
  const verdict = VERDICTS.find((v) => v === raw["verdict"]) ?? fail(file, `has an unknown verdict ${JSON.stringify(raw["verdict"])}`);
  const state = STATES.find((s) => s === raw["state"]) ?? fail(file, `has an unknown state ${JSON.stringify(raw["state"])}`);
  const fixRound = raw["fixRound"];
  if (fixRound !== undefined && JSON.stringify(fixRound) !== JSON.stringify(FIX_ROUND_STATUS)) fail(file, "has a fixRound that is not the loop's");
  return { verdict, status: { state, description: str(file, raw["description"], "description") }, fixRound: fixRound !== undefined };
};

/**
 * Everything `review:publish` reads, checked before its first write. Throws
 * `HandOverError` on a missing or malformed declared file, or on a payload for
 * another commit.
 */
export const readReviewHandOver = (
  dir: Directory<PublishReads>,
  gate: { readonly reviewedSha: string },
  cleanup: Cleanup,
): ReviewHandOver => {
  const cleaned = (text: string): Cleaned => cleanup(text) as Cleaned;

  const payload = dir.json("review_payload.json");
  const input = isRecord(payload) && isRecord(payload["variables"]) ? payload["variables"]["input"] : undefined;
  if (!isRecord(input)) return fail("review_payload.json", "has no variables.input");
  const commitOID = str("review_payload.json", input["commitOID"], "commitOID");
  // ADR 0006: the payload's commit against the one the gate recorded.
  if (commitOID !== gate.reviewedSha) fail("review_payload.json", `is for ${commitOID}, but the review was of ${gate.reviewedSha}`);
  const threads = Array.isArray(input["threads"]) ? input["threads"] : fail("review_payload.json", "has no threads list");
  // The query is read and dropped: the hand-over says what to post, the engine how.

  const parts = dir.json("review_body.json");
  if (!isRecord(parts)) return fail("review_body.json", "is missing or not an object");
  const slotted = str("review_body.json", parts["slotted"], "slotted");
  const slot = str("review_body.json", parts["slot"], "slot");
  if (slotted.split(`\n\n${slot}`).length !== 2) fail("review_body.json", "does not carry its slot exactly once");
  const resolved = Array.isArray(parts["resolved"]) ? parts["resolved"] : fail("review_body.json", "has no resolved list");
  const groups = isRecord(parts["groups"]) ? parts["groups"] : fail("review_body.json", "has no groups");
  const group = (key: string) => {
    const g = groups[key];
    if (!isRecord(g)) return fail("review_body.json", `has no ${key} group`);
    return {
      title: str("review_body.json", g["title"], "title"),
      open: g["open"] === true,
      ...(typeof g["subtitle"] === "string" ? { subtitle: g["subtitle"] } : {}),
    };
  };

  const resolutionsRaw = dir.json("thread_resolutions.json");
  if (!Array.isArray(resolutionsRaw)) return fail("thread_resolutions.json", "is missing or not a list");

  const summaryRaw = dir.json("pr_summary.json");
  const summary = summaryRaw === undefined ? undefined : isRecord(summaryRaw) ? summaryRaw : fail("pr_summary.json", "is not an object");
  const block = summary !== undefined && isRecord(summary["summary"]) ? summary["summary"] : undefined;
  const drop = summary !== undefined && isRecord(summary["drop"]) ? summary["drop"] : undefined;
  const statusLine = dir.text("pr_status.md");

  return {
    review: {
      pullRequestId: str("review_payload.json", input["pullRequestId"], "pullRequestId"),
      commitOID,
      // Each thread's body is agent text; its path and lines are targets (#403), unchecked here.
      threads: threads.map((t) => (isRecord(t) && typeof t["body"] === "string" ? { ...t, body: cleaned(t["body"]) } : fail("review_payload.json", "has a thread with no body"))),
    },
    body: {
      slotted: cleaned(slotted),
      slot,
      resolved: resolved.map((r) => {
        if (!isRecord(r)) return fail("review_body.json", "has a resolved entry that is not an object");
        const threadId = r["threadId"];
        return { ...(typeof threadId === "string" ? { threadId } : {}), line: cleaned(str("review_body.json", r["line"], "line")) };
      }),
      groups: { resolved: group("resolved"), unclosed: group("unclosed") },
    },
    ...readVerdict(dir.json("verdict.json")),
    resolutions: resolutionsRaw.map((r) => {
      if (!isRecord(r)) return fail("thread_resolutions.json", "has an entry that is not an object");
      const reason = r["reason"] === "WONT_FIX" ? "WONT_FIX" : r["reason"] === "ADDRESSED" ? "ADDRESSED" : fail("thread_resolutions.json", `has reason ${JSON.stringify(r["reason"])}`);
      return {
        threadId: str("thread_resolutions.json", r["threadId"], "threadId"),
        reason,
        reply: cleaned(str("thread_resolutions.json", r["reply"], "reply")),
        alreadyReplied: r["alreadyReplied"] === true,
      };
    }),
    followUps: dir.exists("follow_ups.md"),
    ...(summary === undefined
      ? {}
      : {
          summary: {
            ...(typeof summary["title"] === "string" ? { title: cleaned(summary["title"]) } : {}),
            ...(block === undefined
              ? {}
              : {
                  block: {
                    start: str("pr_summary.json", block["start"], "summary.start"),
                    end: str("pr_summary.json", block["end"], "summary.end"),
                    inner: cleaned(str("pr_summary.json", block["inner"], "summary.inner")),
                  },
                }),
            ...(drop === undefined
              ? {}
              : { drop: { start: str("pr_summary.json", drop["start"], "drop.start"), end: str("pr_summary.json", drop["end"], "drop.end") } }),
          },
        }),
    ...(statusLine === undefined ? {} : { statusLine: cleaned(statusLine) }),
  };
};
