# Simulated state, 2026-11-07 10:00 UTC

Repo: jeffwlawson/agent-workflows; main is at 9b923c9 (the checkout in the working directory). The callers pin v0.8.11, as the checkout's own callers do: read the loop's rules from the checkout's `CONTEXT.md` and `docs/agents/`, which stand in for that tag. The repo runs on the self-hosted service.
Session: a local editor session with the maintainer, Jeff, present. `gh` REST and GraphQL both work. The skills `merge-check` and `issues-to-prd` are installed beside `conduct`, with Matt Pocock's `triage`, `to-spec`, `to-tickets`, `retro` and `writing-for-agents`.
The ledger from the last session is `./ledger.md`; Jeff has said its delegations still stand.

## #845 "loop-token: name the expired key in its failure" (ready-for-agent, bug)
Labels: `agent:implement`. Brief dated 2026-11-06T12:00Z, read at 9b923c9. Criteria: (1) the loop-token step's failure names the key that expired; (2) a test asserts it. Where things are: `.github/actions/loop-token/action.yml`, `tests/loop-token-step.test.ts`. After merge, by a human: none.

## #846 "loop-token: name the expired key in its failure" (Closes #845)
Draft, opened by the loop's App at 09:52Z from `agent/issue-845-loop-token-…`. Run `implement` in progress (https://github.com/jeffwlawson/agent-workflows/actions/runs/9301). Comments: 1.
Files: `.github/actions/loop-token/action.yml`, `tests/loop-token-step.test.ts`.

## What the watch would print

`snapshot 846` now:
{"n":846,"pr":true,"state":"open","merged":false,"labels":[],"comments":1,"updated":"2026-11-07T09:52:00Z","draft":true,"head":"0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6","mergeable":"clean","verdict":null,"statuses":{},"checks":{"ok":0,"failed":0,"pending":2}}

A `wait-until` started now on a hand-back predicate prints `wait-until pid=48211 started 10:00:05Z, for up to 120 minutes, watching 846`, then:
10:31:40Z changed: {"n":846,…,"labels":["agent:review"],"comments":2,"draft":false,"head":"5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d","verdict":{"state":"pending","description":"Reviewing","url":"…"},"checks":{"ok":4,"failed":0,"pending":1}}
10:49:12Z changed: {"n":846,…,"labels":[],"comments":3,"draft":false,"head":"5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d","verdict":{"state":"success","description":"Approval recommended","url":"https://github.com/jeffwlawson/agent-workflows/pull/846#pullrequestreview-1"},"statuses":{"agent-review":"success"},"checks":{"ok":5,"failed":0,"pending":0}}
MATCH 10:49:12Z
(and the last snapshot). The process has exited.

## What merge-check would report

A `merge-check` of #846 at `5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d` reports: **Merge-ready at `5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d`**; verify exit 0 on that head; both criteria met; no findings; no After-merge items.

The head is still `5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d` when the check ends.
