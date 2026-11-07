# Briefs

Every question to the maintainer is a **brief**: prepared before it is asked, asked once, and short enough to answer from a phone. The shape is the repo's `CLAUDE.md` *Asking me to decide*, where it has one:

1. **The stake**, one sentence: what changes depending on the answer.
2. **The question**, sentence two.
3. At most three sentences of body: **one recommendation, one reason**.
4. Then the evidence, where it can be skipped: links to the issues, pull requests and runs, never their pasted text.

Where nothing changes with the answer, decide it, say what you decided, and ask nothing. Where the maintainer says it is over their head, say it again in everyday words with one example. Each template below is a shape, not a script: fill it from the record.

## Checkpoint 1: delegate a batch

> **Which work the loop builds next, and in what order.** Post these <k> briefs and build these <m> tasks one at a time, in this order? I recommend yes: <one reason, such as "#A fixes the bug #B's brief assumes is fixed">.
>
> 1. #A <title>: briefed (current) · touches `<files>`
> 2. #P <PRD title> (3 slices), held after slice 1 for a merge-check (hold issue to create)
> 3. #B <title>: brief drafted at `<path>` · waits for #A (same file `<file>`)
>
> Left out: #C (already running as #812), #D (blocked by #650, not in this batch).
> Triage: #B on Sonnet (a docs change); #E on Opus, more effort (it touches the sandbox's proxy).

Questions triage left open go after it, each its own stake and recommendation, so one reply settles the batch.

## Checkpoint 2: decide a hand-back

Merge-ready:

> **Whether #812 merges now.** Arm `agent:merge` at `3f9c1e2`? I recommend arming: merge-check found nothing on that head and verify passed.
>
> Checked: `merge-check` on Opus (it touches `deploy/`), head `3f9c1e2…` (40 characters in the ledger), verify 0, every criterion met. After merge, by a human: run the deployment's check on the box.

With findings:

> **Whether #812 gets a fix round or a closer look.** Post these 2 findings and add `agent:fix` (2 of 3 rounds left)? I recommend the fix round: both are mechanical, a missing test and a stale doc line.
>
> 1. `setup/doctor.ts:88`: the warning names no value. Done when it prints the value.
> 2. `docs/ADOPTING.md` §2c: says nothing of the warning, which the brief's criterion 3 asks for.

A parked task, when its way on is the maintainer's: the loop's reason quoted, the ways on it names, and one recommended.

## Checkpoint 3: cut a release

> **Whether adopters get #812 and #815 now.** Cut v0.9.20 from the main checkout at `a1b2c3d` (origin's tip)? I recommend cutting it: two fixes adopters asked for, and no chain is mid-run.
>
> Since v0.9.19: #812, #815 (one Adopter action: <its sentence>). After merge, by a human: none open.

## Checkpoint 4: restart the service

> **Whether the service runs v0.9.20 tonight.** Run `upgrade.sh 0.9.20` on the Unraid host? I recommend it without `--now`: the worker holds 1 job (#816's review), and the wait lets it finish.
>
> Both machines: v0.9.19 (from the deployment's check at 18:02Z). `--now` would drop #816's review mid-run; its label stays, so the start scan runs it again from the beginning.

## The lock, and the delegations in force

> **Whether two sessions conduct this repo at once.** Another session (conduct-20261107T1402Z-7f3a, since 14:02Z) holds the lock: take over? I recommend taking over only if that session is closed: two conductors queue and merge over each other.

> **What I may do without asking.** These delegations are in force from the last session: build #B after #A; merge on a clean check. Still yes to both? I recommend yes: nothing they cover has changed since.

## The digest

The digest is `merge-check`'s (its `references/digest.md`): six headings, *Needs you* first. Read it as it is; do not re-derive it. Where the maintainer runs it on a schedule, read the newest one; else run `/merge-check --digest` in one fresh sub-agent on Sonnet. Print it at the end of the session, with *Needs you* at the top of your message.

## The retro

Dispatch one fresh sub-agent:

> Read `../retro/SKILL.md` (beside the `conduct` skill's folder) and follow it over this session. Its first sources are these escapes from the ledger, each a finding the loop's review approved and a human-side check caught: <the escape entries, verbatim>. The loop's review is the reviewer agent its *Coding standards* names. Return its candidates, most severe first. Change and post nothing.

Then one brief over what it returns, the escapes first:

> **Whether the review learns from today's 2 escapes.** Add a test for the first and a standards line for the second, and append the friction entry below? I recommend all three: each escape would recur on the next pull request of its kind.
>
> 1. #812, mechanical: <finding>. Proposal: <a test or a check, and where>.
> 2. #815, judgement: <finding>. Proposal: <a line, and in which file>.
>
> Friction entry, drafted for `docs/friction.md` (append-only): <the dated entry>.

A session with no escapes says so in one line and asks nothing.
