### On the linked issue

**@jeffwlawson:**
## Agent Brief

**Category:** bug

**Summary:** A tag named like a branch (`main`, or `origin/main`) must not change which commit the service's checkout or update-branch's merge reads.

**Confirmed, with one more site than the issue names.** Reproduced against git in scratch repositories on 2026-10-31:
- `git checkout -B main main` with both a tag and a branch called `main` fails: `fatal: ambiguous object name: 'main'`.
- `git merge origin/main` with a tag called `origin/main` merges the tag (`Merge tag 'origin/main'`), ahead of the remote-tracking branch.
- **Not in the issue:** an implement job passes the base's *name* as `sha`, and the checkout's fetch uses it as the refspec source (`+<sha>:refs/remotes/origin/<branch>`). `git fetch --tags origin +main:refs/remotes/origin/main` with a tag `main` on the remote fetches the **tag** into `origin/main`, silently. So qualifying only the checkout and the merge leaves implement building on the tag's commit.

**Desired behaviour.** Every ref the service's checkout and update-branch's merge name is fully qualified (`refs/heads/…`, `refs/remotes/origin/…`), in the fetch's source and destination, the checkout's start point and the merge's operand, so no tag can shadow a branch.

**Keep the merge commit's subject.** Merging `refs/remotes/origin/main` makes git write `Merge remote-tracking branch 'refs/remotes/origin/main'`, not `'origin/main'`. The subject a person's `git merge origin/<base>` makes is the documented intent (the comment above the merge) and `tests/engine/git.test.ts` asserts it, so pass the message explicitly where none was given.

**Acceptance criteria**
- [ ] An implement job's checkout succeeds, and is at the base branch's commit, when a tag named like the base branch exists in the repository.
- [ ] An implement job's base is the branch's commit, not the tag's, when the tag is on a different commit.
- [ ] update-branch's merge brings in the base branch's commit, not that of a tag named `origin/<base>`, and its report names the real base.
- [ ] The merge commit's subject is unchanged from today's: `Merge remote-tracking branch 'origin/<base>' into <branch>`.
- [ ] A test for each of the three sites runs with a shadowing tag present and fails without the change.
- [ ] Tags are still fetched into the checkout (#567).

**Out of scope:** removing the tag fetch; jobs whose `sha` is a commit id (not affected).

## Where things are

Read at `main` 4896b68, 2026-10-31.

`service/worker.ts` (the implement base checkout, `checkOut`, passing `branch`/`sha`/`baseRef` all as the base's name), `service/worker-live.ts` (the checkout's fetch refspecs and `checkout -B`), `engine/git.ts` (`gitMerger`: the `tracking` ref, and the merge operand `origin/${base}`), `tests/engine/git.test.ts`, `tests/service/worker-live.test.ts`.

## Overlap checked

No other open issue or PR touches these lines; #568, which introduced the tag fetch, is merged. Needs no coordination with #571 (different files). Host-neutral.

---

**@jeffwlawson-agent-loop[bot]:**
**`agent:implement` started:** [Workflow run](https://github.com/apps/jeffwlawson-agent-loop)

---

**@jeffwlawson-agent-loop[bot]:**
**`agent:implement` opened PR #584:** [Workflow run](https://github.com/apps/jeffwlawson-agent-loop)
