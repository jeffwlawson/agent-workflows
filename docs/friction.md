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

## 2026-07-22 — First local run: Sandcastle's shell escaping is POSIX-only

**What happened.** The very first attempt to run `implement.ts` locally on Windows died before
the agent did any work:

```
FAILED: claude-code exited with code 1:
There's an issue with the selected model ('claude-opus-4-8').
It may not exist or you may not have access to it.
```

**What it looked like.** A model-availability or entitlement problem — the obvious readings
being "the OAuth token lacks Opus 4.8" or "the model id is wrong". Both were wrong.

**What it actually was.** `@ai-hero/sandcastle@0.12.0`, `dist/index.js:2788`:

```js
var shellEscape = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
```

POSIX single-quote escaping with no platform branch. `claudeCode`'s `buildPrintCommand`
interpolates `--model ${shellEscape(model)}` into a command string that is executed via the
platform shell. On Linux `sh` strips the quotes; on Windows `cmd.exe` does not treat `'` as a
quoting character, so Claude Code receives a model named **`'claude-opus-4-8'`** — quotes
included — and the API returns 404 `model_not_found`.

**How it was isolated.** Narrowing, in this order:

1. `claude --model claude-opus-4-8 -p ...` → works. So the model id is valid.
2. The exact Sandcastle command shape (`--print --verbose --output-format stream-json -p -`)
   → works. So the flag combination is fine.
3. Same command with `CLAUDE_CODE_OAUTH_TOKEN` exported → works. **So the token is fine, and
   Opus 4.8 is entitled.** This ruled out the two hypotheses that looked most likely.
4. Same command with the model passed as `"'claude-opus-4-8'"` → reproduces the error
   *byte for byte*, and the stream-json `init` event shows `"model":"'claude-opus-4-8'"`.

Step 4 is the proof. Steps 1–3 are the ones worth remembering: the error message pointed
confidently at the wrong subsystem, and two plausible theories had to be killed before the
real cause was even visible.

**Impact.** Windows-only, and it affects local prompt tuning *only*:

- **CI is unaffected.** GitHub runners are Linux, `sh` strips the quotes, same code path works.
- The bug is not Claude-specific. `pi`, `codex`, `opencode` and `copilot` all build commands
  through the same `shellEscape`, so every provider is affected on Windows.

**Resolution.** Abandoned local prompt tuning; going straight to CI. The upstream bug is
recorded here rather than filed for now.

**The lesson that generalises.** The handoff mandated WSL-native work and gave two reasons:
`/mnt/c` is slow under Docker, and CRLF. Decision 2 removed Docker, so only CRLF appeared to
survive — and CRLF was solved with `.gitattributes`. That reasoning was sound and still wrong,
because there was a *third* reason nobody had enumerated: the toolchain assumes a POSIX shell.
Dropping a constraint because its stated justifications no longer apply is not the same as
verifying the constraint is unnecessary.

Cost: about 30 minutes, all of it before a single line of agent-written code existed.

---

## Pending — not yet exercised

Nothing below has survived contact with a real run:

- No agent run has happened yet. Everything above is setup friction.
- `AGENT_PAT` is deliberately unset. Consequence to watch: `ci.yml` will **not** run on the
  agent's PR, because pushes made with `GITHUB_TOKEN` do not trigger workflows. If that proves
  annoying in practice, that is the signal to create the PAT.
- `maxIterations: 1` is untested. If the agent routinely runs out of room, note it here before
  raising it.
