## What to build

Once a repository sets `AGENT_ORCHESTRATOR` to `service`, `doctor` switches to `diagnoseService`, which returns before the pin checks. But the Actions reusables only skip every job on `vars.AGENT_ORCHESTRATOR != 'service'` from the release that added the guard. A caller pinned to an earlier release has no such guard, so it still runs on Actions beside the service, and `doctor` reports the repository as fine.

Make `doctor` fail that: in a repository served by the service, a caller whose pin is older than the first release carrying the guard is an **error** finding, naming the caller file and the minimum version, with `init` as the fix (it moves the pin in the adopter's own text and touches nothing else).

The first release is **v0.8.3** (verified: `git show v0.8.2:.github/workflows/review.yml` has no `!= 'service'`; `v0.8.3` has it, added by #459 together in `review`, `fix`, `update-branch`, `implement`, `implement-prd` and `follow-ups`). Keep the minimum as one named constant with its reason beside it, not a literal in the check. A pin that is a SHA, not an exact tag, cannot be ordered: say so as a note rather than passing or failing it, and an unreadable tag list stays `undefined`-style "could not check", never a pass.

## Acceptance criteria

- With the orchestrator variable `service`, a caller pinned below the minimum yields an error naming the file, its pin and the minimum, with `init` as the fix; a caller at or above it yields nothing.
- A SHA-pinned or otherwise unorderable pin is a note saying it could not be ordered.
- Without `service`, the Actions path's findings are unchanged.
- The minimum is derived in exactly one place, and a test fails if the constant names a release whose workflows lack the guard (checked against the repository's own history or a fixture, not a hard-coded tag list).
- The finding is covered through `diagnose`, the pure half; `gatherFacts` gains no new fact if the pin is already on the caller.
- Docs: `docs/ADOPTING.md` or the deployment guide says a service repository's callers must be at the minimum release or later.

## Where things are

Read at `main` a3a39c2, 2026-10-31.

- `setup/doctor.ts`: `diagnose` returns `diagnoseService(callers, facts, packageName)` when `facts.orchestrator === SERVICE_ORCHESTRATOR` (~line 518); `diagnoseService` (~line 1351); the Actions-side `pin shape` and `pin freshness` checks (~lines 775 to 1290) show how a ref is parsed (`TAG`, `SHA`) and compared.
- `.github/workflows/review.yml` and the other reusables: the `vars.AGENT_ORCHESTRATOR != 'service'` guards.
- `#455` introduced the variable; `#459` first shipped the guard (v0.8.3).

## Overlap

Checked 2026-10-31 against open issues and PRs: no overlap. #371 (doctor: fail callers pinned to different refs) touches the same function but a different rule; either order merges with small conflicts in `setup/doctor.ts`. #223 (doctor on a schedule) is orthogonal: it runs doctor, this changes what doctor says.

## Constraints (design guardrails)

The owner wants nothing here that blocks opening the package to the public later.

- Nothing owner-specific (IPs, host or account names, Unraid, Tailscale, `jeffwlawson`) is baked into package code or its tests' expectations. Values come from `package.json`, the App's own record, a setting, or what the operator types.
- The feature stays host-neutral and orchestrator-neutral: it works the same on any machine that runs the service, and does not change what the Actions orchestrator does.
- Anything that supports only one setup says so in the docs it touches.
