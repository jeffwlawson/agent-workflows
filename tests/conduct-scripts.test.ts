import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUBPROCESS_TIMEOUT } from "../vitest.config.js";

/**
 * The `conduct` skill's watch scripts (#592), against a fake `gh` that serves
 * canned REST responses with ETags and answers a matching `If-None-Match` with
 * a 304, as GitHub does. What is pinned is the rate budget: one listing call
 * per poll for everything watched, and a poll where nothing changed costing
 * nothing against the token's limit.
 */

const SCRIPTS = path.resolve("skills/conduct/scripts");
const HEAD = "a".repeat(40);
const LISTING = "issues?state=all&sort=updated&direction=desc&per_page=100";

/** Serves `$FAKE_DIR/<path>` (or `<path>.<gen>` once `gen` says so), logging each path it is asked for. */
const FAKE_GH = `#!/usr/bin/env bash
cond="" target=""
while [ $# -gt 0 ]; do case $1 in -H) cond=\${2#If-None-Match: }; shift 2 ;; api|-i) shift ;; *) target=$1; shift ;; esac; done
target=\${target#repos/o/r/}
echo "$target" >>"$FAKE_DIR/calls"
case $target in issues\\?*) echo x >>"$FAKE_DIR/listings" ;; esac
gen=1
[ -f "$FAKE_DIR/flip-after" ] && [ "$(wc -l <"$FAKE_DIR/listings")" -gt "$(cat "$FAKE_DIR/flip-after")" ] && gen=2
name=$(printf %s "$target" | tr '/?&=' '____')
file="$FAKE_DIR/$name"; [ -f "$file.$gen" ] && file="$file.$gen"
[ -f "$file" ] || { printf 'HTTP/2.0 404 Not Found\\r\\n\\r\\n{}'; exit 1; }
etag="\\"$(cksum <"$file" | cut -d' ' -f1)\\""
[ "$cond" = "$etag" ] && { printf 'HTTP/2.0 304 Not Modified\\r\\n\\r\\n'; exit 1; }
printf 'HTTP/2.0 200 OK\\r\\nEtag: %s\\r\\n\\r\\n' "$etag"; cat "$file"
`;

let dir: string;
const serve = (target: string, body: unknown, gen?: number): void => {
  const name = target.replace(/[/?&=]/g, "_") + (gen === undefined ? "" : `.${gen}`);
  fs.writeFileSync(path.join(dir, "fake", name), JSON.stringify(body));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "conduct-scripts-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "fake"));
  fs.writeFileSync(path.join(dir, "bin", "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "fake", "listings"), "");
  const pr = { number: 801, state: "open", pull_request: { merged_at: null }, comments: 2, updated_at: "2026-11-07T10:00:00Z" };
  const issue = { number: 790, state: "open", labels: [{ name: "agent:blocked" }], comments: 1, updated_at: "2026-11-07T09:00:00Z" };
  serve(LISTING, [{ ...pr, labels: [{ name: "agent:review" }] }, issue]);
  serve(LISTING, [{ ...pr, labels: [], comments: 3, updated_at: "2026-11-07T10:20:00Z" }, issue], 2);
  serve("pulls/801", { draft: false, head: { sha: HEAD }, mergeable_state: "clean" });
  const review = { context: "agent-review", target_url: "https://example.com/review" };
  serve(`commits/${HEAD}/status`, { statuses: [{ ...review, state: "pending", description: "Reviewing" }] });
  serve(`commits/${HEAD}/status`, { statuses: [{ ...review, state: "success", description: "Approval recommended" }] }, 2);
  serve(`commits/${HEAD}/check-runs?per_page=100`, {
    check_runs: [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
      { status: "in_progress", conclusion: null },
    ],
  });
  serve("issues/700", { number: 700, state: "closed", labels: [], comments: 5, updated_at: "2026-10-01T00:00:00Z" });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  fs.writeFileSync(path.join(dir, "fake", "calls"), "");
  const result = spawnSync(path.join(SCRIPTS, script), args, {
    encoding: "utf8",
    timeout: SUBPROCESS_TIMEOUT,
    env: {
      ...process.env,
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      REPO: "o/r",
      CONDUCT_CACHE: path.join(dir, "cache"),
      FAKE_DIR: path.join(dir, "fake"),
      ...env,
    },
  });
  const calls = fs.readFileSync(path.join(dir, "fake", "calls"), "utf8").split("\n").filter(Boolean);
  return { ...result, calls, lines: result.stdout.split("\n").filter(Boolean) };
};

describe("snapshot", () => {
  it("reads a watched pull request and issue from one listing call, plus the pull request's head", () => {
    const { status, lines, calls, stderr } = run("snapshot", ["801", "790"]);
    expect(status).toBe(0);
    expect(calls).toEqual([LISTING, "pulls/801", `commits/${HEAD}/status`, `commits/${HEAD}/check-runs?per_page=100`]);
    expect(stderr).toContain("snapshot: 4 calls, 4 counted against the limit");
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      n: 801,
      pr: true,
      state: "open",
      merged: false,
      labels: ["agent:review"],
      comments: 2,
      updated: "2026-11-07T10:00:00Z",
      draft: false,
      head: HEAD,
      mergeable: "clean",
      verdict: { state: "pending", description: "Reviewing", url: "https://example.com/review" },
      statuses: { "agent-review": "pending" },
      checks: { ok: 1, failed: 1, pending: 1 },
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ n: 790, pr: false, labels: ["agent:blocked"] });
  });

  it("costs nothing against the limit on a poll where nothing changed", () => {
    run("snapshot", ["801", "790"]);
    const second = run("snapshot", ["801", "790"]);
    expect(second.calls).toHaveLength(4);
    expect(second.stderr).toContain("snapshot: 4 calls, 0 counted against the limit");
    expect(second.lines).toHaveLength(2);
  });

  it("reads an item the listing does not hold on its own", () => {
    const { lines, calls } = run("snapshot", ["700"]);
    expect(calls).toEqual([LISTING, "issues/700"]);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ n: 700, state: "closed", comments: 5 });
  });

  it("refuses an argument that is not a number", () => {
    const { status, stderr, calls } = run("snapshot", ["#801"]);
    expect(status).toBe(2);
    expect(stderr).toContain("'#801' is not an issue or pull request number");
    expect(calls).toEqual([]);
  });
});

describe("wait-until", () => {
  const approved = '.[0].verdict.state == "success" and (.[0].labels | any(startswith("agent:")) | not)';

  it("prints its pid, then only the item that changed, then MATCH", () => {
    fs.writeFileSync(path.join(dir, "fake", "flip-after"), "1");
    const { status, lines } = run("wait-until", ["5", approved, "801", "790"], { EVERY: "1" });
    expect(status).toBe(0);
    expect(lines[0]).toMatch(/^wait-until pid=\d+ started /);
    const changed = lines.filter((line) => line.includes(" changed: "));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('"n":801');
    expect(lines.at(-3)).toMatch(/^MATCH \d\d:\d\d:\d\dZ$/);
    expect(JSON.parse(lines.at(-2) ?? "")).toMatchObject({ n: 801, verdict: { state: "success" } });
  });

  it("prints nothing between its start and TIMEOUT when nothing changes", () => {
    const { status, lines } = run("wait-until", ["0", approved, "801"], { EVERY: "1" });
    expect(status).toBe(1);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^TIMEOUT /);
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ n: 801, verdict: { state: "pending" } });
  });

  it("refuses a predicate that does not compile, before any call", () => {
    const { status, stderr, calls } = run("wait-until", ["5", ".[0].state ==", "801"]);
    expect(status).toBe(2);
    expect(stderr).toContain("the predicate does not compile");
    expect(calls).toEqual([]);
  });

  it("stops on the first poll where the predicate errors, rather than waiting out the bound", () => {
    const { status, stderr, lines } = run("wait-until", ["5", '.[0].labels | startswith("agent:")', "801"], { EVERY: "1" });
    expect(status).toBe(2);
    expect(stderr).toContain("the predicate failed on this snapshot");
    expect(stderr).toContain('"n":801');
    expect(lines).toHaveLength(1);
  });
});
