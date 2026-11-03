---
source: >-
  The fix that shipped for this finding on PR #570: ba76218's change against b41cecd (this case's head), its commit message, and its reply on the thread (https://github.com/jeffwlawson/agent-workflows/pull/570#discussion_r4433646201), laid out as the replay note asks.
expect:
  "01": pass
  "02": pass
  "03": pass
---

1. The change, as `git diff` prints it against the head:

```diff
diff --git a/.github/workflows/implement.yml b/.github/workflows/implement.yml
index acd5eea..ff75437 100644
--- a/.github/workflows/implement.yml
+++ b/.github/workflows/implement.yml
@@ -708,9 +708,10 @@ jobs:
           name: agent-implement
           path: ${{ runner.temp }}/agent-implement
 
-      # The success path (#492): the bundle checked, the push, the rescue
-      # branch deleted under a lease on its tip (#270), the draft PR with its
-      # frame, the link on the issue, and the review request, in that order.
+      # The success path (#492): the bundle checked, the push, the draft PR
+      # with its frame, the rescue branch deleted under a lease on its tip
+      # once the PR holds its commits (#270), the link on the issue, and the
+      # review request, in that order.
       # `implement/publish.ts` says why each is as it is.
       #
       # **The bundle is checked before anything is pushed from it**, against
diff --git a/docs/deploying-the-service.md b/docs/deploying-the-service.md
index f337b4f..67d5863 100644
--- a/docs/deploying-the-service.md
+++ b/docs/deploying-the-service.md
@@ -284,7 +284,7 @@ to implement-prd. Where it claimed the run, the agent's job checks out the commi
 default branch at, and runs `implement:prepare`, which creates the agent's branch there and fetches
 a stopped run's rescue branch, the setup, the runner, and `implement:bundle`, however those ended.
 Where they succeeded, `implement:publish`, in a checkout of the base of its own, pushes the branch,
-deletes the rescue branch, opens the draft pull request as the App, links it on the issue and adds
+opens the draft pull request as the App, deletes the rescue branch, links it on the issue and adds
 `agent:review` as the App, which the dispatcher answers as the App's own label: the pull request
 then flows into review. `implement:conclude` ends every run, in the same checkout, pushing a stopped
 run's commits to `agent/rescue/issue-<n>` for the next run to resume from. The service
diff --git a/docs/platform-spec.md b/docs/platform-spec.md
index 2c30eb6..e0216b1 100644
--- a/docs/platform-spec.md
+++ b/docs/platform-spec.md
@@ -640,8 +640,8 @@ build, and an orchestrator other than Actions sets its environment in its own co
 > artifact, and its last step measures whether it ran out of time, as its `timed-out` output, beside
 > the bundle step's outcome, as its `bundled` output. `RESCUE_BRANCH` is `agent/rescue/issue-<n>`, set on the agent's job and the publish job. A publish
 > job mints the loop's token, checks the default branch out and runs, where the agent's job
-> succeeded, `implement:publish`, which checks the bundle, pushes `BRANCH`, deletes the rescue
-> branch, opens a draft pull request into the default branch, links it on the issue, and adds
+> succeeded, `implement:publish`, which checks the bundle, pushes `BRANCH`, opens a draft pull
+> request into the default branch, deletes the rescue branch, links it on the issue, and adds
 > `agent:review` to it; then, `always()`, `implement:conclude`, which ends every run: the set-aside
 > note, a stopped run's commits rescued to the rescue branch where nothing was pushed, the failure
 > comment and `agent:blocked` where the run stopped, and `agent:implement` off wherever the gate
@@ -683,8 +683,8 @@ build, and an orchestrator other than Actions sets its environment in its own co
 >   run, a checkout of the base branch, by name, of its own, made with it, which the bundle is
 >   checked in. `implement:publish` runs only where the agent's job succeeded and the steps before
 >   it in the publish job did, the mint and the checkout among them: pointed at
->   `implement:bundle`'s directory, it pushes `BRANCH`, deletes the rescue branch, opens the draft
->   pull request as the App, links it on the issue and adds `agent:review` with the App's token.
+>   `implement:bundle`'s directory, it pushes `BRANCH`, opens the draft pull request as the App,
+>   deletes the rescue branch, links it on the issue and adds `agent:review` with the App's token.
 >   Then `implement:conclude`, however the run ended, in the same checkout, pointed at publish's,
 >   prepare's, the runner's and bundle's directories. Publish holds `push` as both `GH_TOKEN` and
 >   `LOOP_TOKEN`, with `LOOP_TOKEN_SOURCE` `app`; conclude holds it as both too, or the `write`
@@ -926,10 +926,12 @@ A check that fails fails the command, and nothing is written.
 
 The order: the push of the bundle's tip to `refs/heads/<BRANCH>` with the loop's token, leased on
 `BRANCH_TIP`, or on the branch not existing where it is empty, so a retry replaces a branch an
-earlier run left and a branch someone pushed to during the run is refused; `RESCUE_BRANCH`
-deleted, with the loop's token, leased on its tip as read, where it exists (#270): what the run
-resumed from is in what it pushed, and a deletion that fails, or a tip that cannot be read, is a
-warning; the draft pull request from `BRANCH` into `BASE_REF`, with the loop's token; `` **`agent:implement` opened PR #<pr>:** ``
+earlier run left and a branch someone pushed to during the run is refused; the draft pull request
+from `BRANCH` into `BASE_REF`, with the loop's token; `RESCUE_BRANCH` deleted, with the loop's
+token, leased on its tip as read, where it exists (#270): what the run resumed from is in what it
+pushed, and the pull request now holds it, whereas an open that failed sends the retry back to the
+base, whose push replaces `BRANCH`, leaving the rescue the one copy; a deletion that fails, or a tip
+that cannot be read, is a warning; `` **`agent:implement` opened PR #<pr>:** ``
 and a link to `RUN_URL` on the issue, with `GH_TOKEN`, tolerated; a bounded wait for the pull
 request to show the pushed head; `agent:implement` off the issue, tolerated; and `agent:review` off
 the pull request, tolerated, and on, with the loop's token, warning where `LOOP_TOKEN_SOURCE` is
diff --git a/implement/publish.ts b/implement/publish.ts
index 92a12fd..3e2632b 100644
--- a/implement/publish.ts
+++ b/implement/publish.ts
@@ -46,10 +46,12 @@ interface Published {
  * earlier failed run left, and a push someone else made during the run is
  * refused rather than overwritten.
  *
- * **The rescue branch is deleted after the push** (#270), leased on its tip
- * as read: the commits a run resumed from are in what it pushed, and a
- * rescue left behind is one the next run would set aside. A deletion that
- * fails is a warning, never a stop.
+ * **The rescue branch is deleted once the pull request is open** (#270),
+ * leased on its tip as read: the commits a run resumed from are in what it
+ * pushed, and a rescue left behind is one the next run would set aside. Not
+ * between the push and the open: an open that fails sends the retry back to
+ * the base, whose push replaces `BRANCH`, so the rescue is all that is left
+ * of those commits. A deletion that fails is a warning, never a stop.
  *
  * **A server error opening the pull request is read back** (#329): the open
  * pull request from exactly this head into exactly this base is this run's,
@@ -101,8 +103,6 @@ export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
   record();
   console.log(`Pushed ${tip} to ${branch}.`);
 
-  await deleteRescue(io, loop, inputs.RESCUE_BRANCH);
-
   // Step 2: the draft pull request, with the loop's token: the Actions bot is
   // forbidden from opening one. The title is the issue's until the first
   // review writes one true of the change, cut at GitHub's 256 characters.
@@ -110,6 +110,12 @@ export const publish = async (inputs: Inputs, io: Io): Promise<void> => {
   state.pr = pr;
   record();
 
+  // The rescue, only once the pull request holds what it resumed from: a
+  // failed open leaves `published.json` with no `pr`, the retry cuts `BRANCH`
+  // afresh at the base and pushes over it, and the rescue is then the one
+  // copy of those commits (#270).
+  await deleteRescue(io, loop, inputs.RESCUE_BRANCH);
+
   // Step 3: the success outcome, said on the issue with the run link (#205),
   // before the review is asked for. A warning where it cannot be posted: the
   // pull request is open either way, and the review must still be requested.
diff --git a/service/worker.ts b/service/worker.ts
index f0f7447..a01d6f4 100644
--- a/service/worker.ts
+++ b/service/worker.ts
@@ -1484,8 +1484,8 @@ const runUpdateBranch = async (job: UpdateBranchJob, edges: JobEdges): Promise<r
  *    included: a `push` token, or where that is refused a `write` token, and
  *    where the gate claimed the run a checkout of the base, by name, of its
  *    own, which the bundle is checked in. Then, where the agent's job and the
- *    mint succeeded, `implement:publish` in it, which pushes, deletes the
- *    rescue branch, opens the pull request, links it on the issue and adds
+ *    mint succeeded, `implement:publish` in it, which pushes, opens the
+ *    pull request, deletes the rescue branch, links it on the issue and adds
  *    `agent:review`.
  * 4. `implement:conclude`, however the run ended, in the same checkout, with
  *    the `push` token, which it rescues a stopped run's commits with, or a
diff --git a/shared/contract.ts b/shared/contract.ts
index c8e8810..4154c63 100644
--- a/shared/contract.ts
+++ b/shared/contract.ts
@@ -1019,8 +1019,8 @@ const REVIEW_RED_CHECK_PLACE = {
  *   error; links it on the issue; waits, bounded by `HEAD_WAIT_SECONDS` and
  *   polled every `HEAD_POLL_SECONDS`, for it to show the pushed head; and
  *   takes `agent:implement` off and puts `agent:review` on, removed first,
- *   with the loop's token. After the push it deletes `RESCUE_BRANCH`, leased
- *   on its tip as read (#270). `published.json` is whether it pushed, the
+ *   with the loop's token. Once the pull request is open it deletes
+ *   `RESCUE_BRANCH`, leased on its tip as read (#270). `published.json` is whether it pushed, the
  *   pushed head, the pull request's number and whether the review was
  *   requested, written as each becomes true.
  * - `review:advance` moves a PRD PR's chain on after a review, or parks it:
diff --git a/tests/implement/publish.test.ts b/tests/implement/publish.test.ts
index 3b0bb3c..69a07a1 100644
--- a/tests/implement/publish.test.ts
+++ b/tests/implement/publish.test.ts
@@ -228,17 +228,17 @@ describe("implement:publish on a bundle that checks out", () => {
 
 /**
  * A run that pushed leaves no rescue branch behind (#270): what it resumed
- * from is in what it pushed. Deleted after the push, under a lease on its tip
- * as read, and never a reason to stop.
+ * from is in what it pushed. Deleted once the pull request is open, under a
+ * lease on its tip as read, and never a reason to stop.
  */
-describe("implement:publish deletes the rescue branch once it has pushed", () => {
-  it("deletes the rescue after the push, leased on its tip, and goes on to open the PR", async () => {
+describe("implement:publish deletes the rescue branch once it has opened the PR", () => {
+  it("deletes the rescue after the PR opens, leased on its tip, and goes on to link it", async () => {
     github.branches.set(RESCUE, RESCUED);
 
     await run();
 
-    expect(writes().slice(0, 3)).toEqual(["loop pushRef", "loop deleteRef", "loop openPullRequest"]);
-    expect(made?.writes[1]?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, lease: { tip: RESCUED } }]);
+    expect(writes().slice(0, 4)).toEqual(["loop pushRef", "loop openPullRequest", "loop deleteRef", "workflow comment"]);
+    expect(made?.writes[2]?.args).toEqual([{ ref: `refs/heads/${RESCUE}`, lease: { tip: RESCUED } }]);
     expect(github.branches.has(RESCUE)).toBe(false);
     expect(logged()).toContain(`Deleted ${RESCUE}: this run succeeded.`);
   });
@@ -269,6 +269,28 @@ describe("implement:publish deletes the rescue branch once it has pushed", () =>
     expect(github.branches.get(RESCUE)).toBe(RESCUED);
     expect(writes()).toEqual(["loop pushRef"]);
   });
+
+  /**
+   * A failed open leaves `published.json` with no `pr`, so the retry cuts
+   * `BRANCH` afresh at the base and its push replaces what this run pushed:
+   * the rescue is then the one copy of those commits, and is kept.
+   */
+  it.each([
+    ["GitHub refuses it", (write: { type: string }) => write.type === "openPullRequest"],
+    [
+      "a server error's read-back fails too",
+      (write: { type: string }, call: string) =>
+        write.type !== "openPullRequest" ? false : call === "POST pulls" ? { status: 502, landed: true } : { status: 503, landed: false },
+    ],
+  ] as const)("keeps the rescue where opening the PR fails because %s", async (_name, fails) => {
+    github.branches.set(RESCUE, RESCUED);
+    github.fails = fails;
+
+    await expect(run()).rejects.toThrow();
+    expect(github.branches.get(RESCUE)).toBe(RESCUED);
+    expect(writes()).toEqual(["loop pushRef", "loop openPullRequest"]);
+    expect(files.get("published.json")).toEqual({ pushed: true, head: TIP, requested: false });
+  });
 });
 
 describe("implement:publish's push", () => {
```

2. The commit message I would have written:

```text
fix(implement): delete the rescue only once the pull request is open (#270)

Addresses review 4's finding on implement/publish.ts:104. implement:publish
deleted RESCUE_BRANCH between the push and openPullRequest. If the open then
failed, published.json said pushed with no pr, conclude rescued nothing, and
the retry cut BRANCH afresh at the base and pushed over it under the gate's
lease, so the rescued commits were lost. The deletion now runs after
`state.pr = pr; record();`.

Covers every way the open can fail between the two: a refusal, and a server
error whose read-back fails too, each tested to keep the rescue. A failure
after the PR is open (the link, the review request) is fine to delete on,
since the PR holds the commits.

fix:publish and implement-prd:publish delete their rescue after a push too,
but onto a branch a retry builds on rather than replaces, so the same loss
does not arise there.

The publish order is updated in docs/platform-spec.md, implement.yml's
comment, docs/deploying-the-service.md, shared/contract.ts and
service/worker.ts.

npm run verify: typecheck passes, and every test but the 12 in
tests/workflows.test.ts that need the v0.9.2 tag, which this checkout cannot
fetch.
```

3. The thread's outcome: **addressed**. The reply I would post:

> Fixed in 6c756d4. `deleteRescue` now runs after `state.pr = pr; record();`, so the rescue survives a failed open and the retry can resume from it. The publish test now expects push, PR, deletion, link. A new test keeps the rescue in both ways the open can fail: GitHub refuses it, or a server error's read-back fails too. The publish order now matches in docs/platform-spec.md, the implement.yml comment, docs/deploying-the-service.md, shared/contract.ts and service/worker.ts.
