# Friction log

Every time a human reaches into the loop, it gets written down here: what broke, what was
done about it. This file — not the linter — is the actual output of the pilot.

Newest last.

---

## 2026-07-22 — Setup

### Label naming was ambiguous because CVM uses `Sandcastle` for something else

**What happened.** The handoff left "is the trigger label `agent:implement` or CVM's
`Sandcastle` spelling?" as an open question, because both strings appear in
`mattpocock/course-video-manager`.

**What it actually is.** They are different things. Across all 7 CVM workflows and all 5
workflows in `mattpocock/sandcastle`, every *trigger* is `agent:*`. `Sandcastle` is CVM's
local spelling of the canonical **triage** label `ready-for-agent` — "fully specified, ready
for an AFK agent" — per `docs/agents/triage-labels.md`. It gates human intent; `agent:implement`
gates the workflow.

**Resolution.** Use `agent:*` for workflow state. We are not adopting a triage label yet —
with one workflow and a hand-written backlog there is no triage step to gate.

### CVM is a version behind upstream, and the two disagree on layout

**What happened.** The handoff points at CVM as the model, but CVM's lockfile pins
`@ai-hero/sandcastle@0.10.0` while npm and `mattpocock/sandcastle` are both on `0.12.0`.
They also disagree on where runner scripts live: CVM uses `.sandcastle/implement/`,
upstream uses `.sandcastle/agent-workflows/implement/`.

**Resolution.** When they disagree, upstream wins. Adopted `agent-workflows/` nesting so the
other workflows can be added later without a rename. Also adopted upstream's `ISSUE_CONTEXT`
promptArg — it reads the issue with `gh` in the *runner script* and passes the text in, so the
agent has no reason to shell out to `gh` itself. Given `noSandbox()` leaks the runner's
`GH_TOKEN` into the agent process, that is a genuine improvement to the boundary, not just tidiness.

### `rootDir` broke `npm run verify` before a single test existed

**What happened.** Put `rootDir: "src"` and `outDir` in the base `tsconfig.json`, which also
`include`s `tests/`. `tsc --noEmit` immediately failed with TS6059 — test files are not under
`rootDir`.

**Resolution.** Base config is for typechecking (no `rootDir`, includes `src`, `tests` and
`.sandcastle`); `tsconfig.build.json` adds `rootDir`/`outDir`/`declaration` and narrows to
`src`. Worth recording because Gotcha 3 in the handoff says `npm run verify` must be green
from commit one, and this is exactly the class of thing that silently isn't.

### Windows-native, not WSL

**What happened.** The handoff specified WSL-native work because `/mnt/c` is slow under Docker
and causes CRLF problems. Decision 2 removed Docker entirely, so only the CRLF half survives.

**Resolution.** Working in `C:\Repos\winget-manifest-lint`. `.gitattributes` with
`* text=auto eol=lf` landed in the very first commit, before any source file, with fixtures
and schemas marked `-text` so byte-comparison tests stay honest. Local Node is v24 while
upstream's template pins 22; pinned ours via `.nvmrc` so the runner, CI and the dev machine
cannot drift apart.

---

## Pending — not yet exercised

Nothing below has survived contact with a real run:

- No agent run has happened yet. Everything above is setup friction.
- `AGENT_PAT` is deliberately unset. Consequence to watch: `ci.yml` will **not** run on the
  agent's PR, because pushes made with `GITHUB_TOKEN` do not trigger workflows. If that proves
  annoying in practice, that is the signal to create the PAT.
- `maxIterations: 1` is untested. If the agent routinely runs out of room, note it here before
  raising it.
