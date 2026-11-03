---
source: >-
  A real fix round on the same pull request that answered a different finding: 4d56bbc's change against 4d4b5e0 on PR #570, its commit message, and its reply on that finding's thread (https://github.com/jeffwlawson/agent-workflows/pull/570#discussion_r4433530093), laid out as the replay note asks.
expect:
  "01": fail
  "02": fail
  "03": fail
---

1. The change, as `git diff` prints it against the head:

```diff
diff --git a/.github/workflows/implement.yml b/.github/workflows/implement.yml
index 9b8ee56..acd5eea 100644
--- a/.github/workflows/implement.yml
+++ b/.github/workflows/implement.yml
@@ -274,10 +274,14 @@ jobs:
     # one fails the job before any step, which `doctor` reports.
     # `implement:conclude` names the same figure.
     timeout-minutes: ${{ fromJSON(vars.AGENT_TIMEOUT_MINUTES || '30') }}
-    # Its one output: whether it ran out of time. See *Measure how the agent's
-    # job ended*. Everything else it hands over is the artifact.
+    # Its two outputs: whether it ran out of time, see *Measure how the
+    # agent's job ended*, and how the bundle step ended (#270), which Actions
+    # sets and the agent cannot: a bundle step stopped before it wrote
+    # anything leaves no file, which `implement:conclude` must not read as no
+    # commits. Everything else it hands over is the artifact.
     outputs:
       timed-out: ${{ steps.outcome.outputs.timed-out }}
+      bundled: ${{ steps.bundle.outcome }}
     # **Read-only, and no PAT or App secret named anywhere in this job.** Not
     # even in a step that never runs: a secret is delivered to every job whose
     # text names it.
@@ -534,6 +538,7 @@ jobs:
       # `GH_TOKEN` is set empty for it. Into a directory of its own, which the
       # hand-over below carries beside the runner's files.
       - name: Bundle the branch
+        id: bundle
         if: always()
         working-directory: ${{ runner.temp }}
         env:
@@ -559,8 +564,9 @@ jobs:
       #
       # What this job hands over is the agent's to write, whatever a step here
       # meant it to be. So `publish` takes nothing from it but this artifact,
-      # which it checks, and `timed-out`, which decides nothing (see the step
-      # after this one).
+      # which it checks, `timed-out`, which decides nothing (see the step
+      # after this one), and `bundled`, the bundle step's outcome, which only
+      # picks between two sentences where there is no bundle.
       - name: Hand the branch to the publish job
         if: always()
         uses: actions/upload-artifact@v7
@@ -796,6 +802,7 @@ jobs:
           MINT_OUTCOME: ${{ steps.token.outcome }}
           DOWNLOAD_OUTCOME: ${{ steps.fetch.outcome }}
           PUBLISH_OUTCOME: ${{ steps.publish.outcome }}
+          BUNDLE_OUTCOME: ${{ needs.implement.outputs.bundled }}
         run: npm exec --prefix "$RUNNER_TEMP" --yes --package=@jeffwlawson/agent-workflows@0.9.2 -- agent-workflows implement:conclude
 
       # Every write the two commands made, one line each as it landed, and a
diff --git a/docs/platform-spec.md b/docs/platform-spec.md
index b4a0a0e..bf3ddef 100644
--- a/docs/platform-spec.md
+++ b/docs/platform-spec.md
@@ -637,8 +637,8 @@ build, and an orchestrator other than Actions sets its environment in its own co
 > `implement:prepare`, which creates `BRANCH` at the gate's base commit and fetches the rescue
 > branch, then the runner, by the install's path, and, however it ended, `implement:bundle`; it
 > hands the bundle, every reason file and the rescue it set aside to the publish job as one
-> artifact, and its last step measures whether it ran out of time, as its `timed-out` output.
-> `RESCUE_BRANCH` is `agent/rescue/issue-<n>`, set on the agent's job and the publish job. A publish
+> artifact, and its last step measures whether it ran out of time, as its `timed-out` output, beside
+> the bundle step's outcome, as its `bundled` output. `RESCUE_BRANCH` is `agent/rescue/issue-<n>`, set on the agent's job and the publish job. A publish
 > job mints the loop's token, checks the default branch out and runs, where the agent's job
 > succeeded, `implement:publish`, which checks the bundle, pushes `BRANCH`, deletes the rescue
 > branch, opens a draft pull request into the default branch, links it on the issue, and adds
@@ -709,7 +709,8 @@ build, and an orchestrator other than Actions sets its environment in its own co
 >   still running at it is ended with every process it started: the agent's job is then
 >   `cancelled`, with `TIMED_OUT` `true` and `TIMEOUT_MINUTES` the limit, which on Actions the job's
 >   last step measures. `implement:bundle` gets 5 minutes of its own after it, as `fix:bundle`
->   does. Publish's checkout and `implement:publish` share the publish job's 15 minutes, and
+>   does; one still running at it is `BUNDLE_OUTCOME` `cancelled`, as the step's outcome is on
+>   Actions, so conclude says the commits went unsaved. Publish's checkout and `implement:publish` share the publish job's 15 minutes, and
 >   `implement:conclude` gets 15 of its own. The dispatcher's deadline for the job is
 >   the agent's limit plus its margin.
 > - **A phase not started leaves its reason** where `implement:conclude` reads the next one: a
@@ -1018,8 +1019,9 @@ held. Never `BRANCH`, no pull request, no review and no label. No bundle is no c
 `BASE_SHA`, and nothing is pushed. The bundle is checked in `CHECKOUT` as `implement:publish`
 checks it, against `BRANCH` and `BASE_SHA`. An empty `LOOP_TOKEN` or a mint that did not succeed,
 a bundle that fails a check, a rescue's tip that cannot be read, a push that fails, and, with no
-bundle, a `failure_reason.txt` in `BUNDLE_DIR` or a `DOWNLOAD_OUTCOME` of `failure`, each rescue
-nothing, with a warning, and the comment says the commits were not saved, and why.
+bundle, a `failure_reason.txt` in `BUNDLE_DIR`, a `DOWNLOAD_OUTCOME` of `failure`, or a
+`BUNDLE_OUTCOME` of `failure` or `cancelled` (a bundle step ended before it wrote anything), each
+rescue nothing, with a warning, and the comment says the commits were not saved, and why.
 - **A gate that did not decide** (`REFUSED` is empty): the same comment and `agent:blocked`, and
   `agent:implement` is **left on**: that run may have been the event `implement-prd` answers, which
   holds the label while it works.
@@ -1042,7 +1044,9 @@ them. ``; where they went unsaved, the retry is followed by `` Its commits were
 them with. ``, `` they could not be checked against `<BASE_REF>` before the push, and the workflow
 run's log says why. ``, `` GitHub would not say whether the branch already holds commits, so
 pushing could have overwritten them. ``, `` GitHub refused the push, and the workflow run's log
-says why. ``, `` the agent's job could not bundle them, and the workflow run's log says why. `` or
+says why. ``, `` the agent's job could not bundle them, and the workflow run's log says why. ``,
+`` the agent's job was stopped before it finished bundling them, and the workflow run's log says
+why. `` or
 `` what the agent's job handed over could not be fetched, so there were none to push. ``
 
 Each directory is read on its own, so a file that does not read is a warning and is read as not
@@ -1072,6 +1076,7 @@ comment still takes its label off. Every write but the rescue is made with `GH_T
 | `MINT_OUTCOME` | optional | `""` | The outcome of minting the loop's token: `success`, `failure`, `cancelled` or `skipped`. Empty is not run. |
 | `DOWNLOAD_OUTCOME` | optional | `""` | The same, for fetching the agent's hand-over. |
 | `PUBLISH_OUTCOME` | optional | `""` | The same, for `implement:publish`. |
+| `BUNDLE_OUTCOME` | optional | `""` | The same, for `implement:bundle`, in the agent's job. With no bundle, `failure` or `cancelled` is commits not saved rather than none. |
 | `PUBLISH_DIR` | directory | | `implement:publish`'s `OUTPUT_DIR`. Reads `published.json` (where written) and `failure_reason.txt` (where written). |
 | `PREPARE_DIR` | directory | | `implement:prepare`'s `OUTPUT_DIR`. Reads `failure_reason.txt` (where written). |
 | `IMPLEMENT_DIR` | directory | | The `implement` runner's `OUTPUT_DIR`. Reads `failure_reason.txt` (where written) and `rescue_ignored.json` (where written). |
@@ -1095,8 +1100,9 @@ comment still takes its label off. Every write but the rescue is made with `GH_T
 > `RUNNER_TEMP`, as are the Node setup and the upload around it, and the checkout and the download
 > wherever the gate claimed the run. It is told the gate's `refused` output, result and
 > `failure-reason` output, which the gate job's glue step copies from `implement:gate`'s reason
-> file, the agent's job's result and its `timed-out` output, the limit as `AGENT_TIMEOUT_MINUTES` or
-> 30, and the outcomes of the mint, the download and `implement:publish`. `PUBLISH_DIR` is
+> file, the agent's job's result, its `timed-out` output and its `bundled` output, the bundle step's
+> outcome, the limit as `AGENT_TIMEOUT_MINUTES` or 30, and the outcomes of the mint, the download and
+> `implement:publish`. `PUBLISH_DIR` is
 > `implement:publish`'s `OUTPUT_DIR`, and `PREPARE_DIR`, `IMPLEMENT_DIR` and `BUNDLE_DIR` where the
 > agent's artifact is downloaded, a directory of its own under `runner.temp`, so the mint's reason
 > file is never read as the runner's. `CHECKOUT` is the publish job's one checkout, `RESCUE_BRANCH`
diff --git a/implement/conclude.ts b/implement/conclude.ts
index c75a497..45b90a8 100644
--- a/implement/conclude.ts
+++ b/implement/conclude.ts
@@ -226,8 +226,9 @@ type Saved = { readonly kind: "none" } | { readonly kind: "rescued" } | { readon
  *
  * Only where nothing was pushed to `BRANCH`, which the caller checks, and
  * where there is a bundle: none is a run with no commits ahead of the base it
- * started from, unless `implement:bundle` failed or the hand-over could not be
- * fetched, when what the run made is unknown and said to be unsaved. The
+ * started from, unless `implement:bundle` failed, was stopped before it
+ * wrote anything (`BUNDLE_OUTCOME`), or the hand-over could not be fetched,
+ * when what the run made is unknown and said to be unsaved. The
  * bundle is checked as `implement:publish` checks it, and one that fails a
  * check is not rescued.
  *
@@ -252,6 +253,17 @@ const rescueCommits = async (inputs: Inputs, io: Io, loop: Writer, bundled: bool
       console.log(`::warning::What the agent's job handed over could not be fetched, so no commits were saved on ${rescue}.`);
       return { kind: "unsaved", why: UNFETCHED };
     }
+    // A bundle step ended before it wrote anything, by its time limit, a
+    // cancel, or a failure before the command could write its reason: what
+    // the run made is unknown, not none.
+    if (inputs.BUNDLE_OUTCOME === "cancelled") {
+      console.log(`::warning::The agent's commits were not bundled before the bundle step was stopped, so none were saved on ${rescue}.`);
+      return { kind: "unsaved", why: UNFINISHED };
+    }
+    if (inputs.BUNDLE_OUTCOME === "failure") {
+      console.log(`::warning::The agent's commits could not be bundled, so none were saved on ${rescue}.`);
+      return { kind: "unsaved", why: UNBUNDLED };
+    }
     console.log("No commits ahead of the base this run started from, so there is nothing to rescue.");
     return { kind: "none" };
   }
@@ -294,6 +306,7 @@ const rescueCommits = async (inputs: Inputs, io: Io, loop: Writer, bundled: bool
 /** Why a stopped run's commits went unsaved, each as the comment says it after "were not saved on `<rescue>`:". */
 const NO_TOKEN = "the loop's token was not minted, so there was nothing to push them with.";
 const UNBUNDLED = "the agent's job could not bundle them, and the workflow run's log says why.";
+const UNFINISHED = "the agent's job was stopped before it finished bundling them, and the workflow run's log says why.";
 const UNFETCHED = "what the agent's job handed over could not be fetched, so there were none to push.";
 const UNCHECKED = (base: string): string => `they could not be checked against \`${base}\` before the push, and the workflow run's log says why.`;
 const UNREAD = "GitHub would not say whether the branch already holds commits, so pushing could have overwritten them.";
diff --git a/service/worker.ts b/service/worker.ts
index 3d6e083..78a1c92 100644
--- a/service/worker.ts
+++ b/service/worker.ts
@@ -1556,6 +1556,9 @@ const runImplement = async (job: ImplementJob, edges: JobEdges): Promise<readonl
   const minutes = fixTimeLimit(job.variables.AGENT_TIMEOUT_MINUTES);
   const agent: { result: JobResult; timedOut: boolean } = { result: "skipped", timedOut: false };
   const bundleDir = outputDir("implement:bundle");
+  // How `implement:bundle` ended, as the bundle step's `outcome`: one stopped
+  // at its limit writes nothing, which conclude must not read as no commits.
+  let bundleOutcome = "";
   if (gateResult === "success" && refused === "false") {
     agent.result = "success";
     const agentLimit = limit(minutes);
@@ -1638,6 +1641,7 @@ const runImplement = async (job: ImplementJob, edges: JobEdges): Promise<readonl
     const bundleLimit = limit(BUNDLE_MINUTES);
     const bundled = await run("implement:bundle", { CHECKOUT: checkout, BRANCH: branch, BASE_SHA: base }, edges.runDir, bundleLimit.signal);
     bundleLimit.clear();
+    bundleOutcome = bundled.timedOut ? "cancelled" : bundled.ok ? "success" : "failure";
     if (bundled.timedOut && agent.result === "success") agent.result = "cancelled";
     else if (!bundled.ok && agent.result === "success") agent.result = "failure";
   }
@@ -1734,6 +1738,7 @@ const runImplement = async (job: ImplementJob, edges: JobEdges): Promise<readonl
       MINT_OUTCOME: mintOutcome,
       DOWNLOAD_OUTCOME: agentRan ? "success" : "",
       PUBLISH_OUTCOME: publishOutcome,
+      BUNDLE_OUTCOME: bundleOutcome,
       PUBLISH_DIR: publishDir,
       PREPARE_DIR: outputDir("implement:prepare"),
       IMPLEMENT_DIR: outputDir("implement"),
diff --git a/shared/contract.ts b/shared/contract.ts
index b38bcbf..c8e8810 100644
--- a/shared/contract.ts
+++ b/shared/contract.ts
@@ -1192,6 +1192,7 @@ export const COMMANDS = {
       MINT_OUTCOME: EMPTY,
       DOWNLOAD_OUTCOME: EMPTY,
       PUBLISH_OUTCOME: EMPTY,
+      BUNDLE_OUTCOME: EMPTY,
       PUBLISH_DIR: readsFromCommand("implement:publish", IMPLEMENT_PUBLISH, {
         "published.json": "sometimes",
         "failure_reason.txt": "sometimes",
diff --git a/tests/implement/conclude.test.ts b/tests/implement/conclude.test.ts
index bbc41bf..0c43a80 100644
--- a/tests/implement/conclude.test.ts
+++ b/tests/implement/conclude.test.ts
@@ -114,6 +114,7 @@ const INPUTS = (over: Partial<Inputs> = {}): Inputs => ({
   MINT_OUTCOME: "success",
   DOWNLOAD_OUTCOME: "success",
   PUBLISH_OUTCOME: "success",
+  BUNDLE_OUTCOME: "success",
   PUBLISH_DIR: dirOf("publish"),
   PREPARE_DIR: dirOf("prepare"),
   IMPLEMENT_DIR: dirOf("runner"),
@@ -744,6 +745,28 @@ describe("implement:conclude rescues a stopped run's commits to a side branch",
     expect(comment()).toContain(unsaved("the agent's job could not bundle them, and the workflow run's log says why."));
   });
 
+  /**
+   * A bundle step ended before it wrote anything (#270): stopped at its own
+   * limit on the service, or in a cancel on Actions, or failed before the
+   * command could write its reason. No file is then unknown, not no commits.
+   */
+  it.each([
+    ["was stopped", "cancelled", "the agent's job was stopped before it finished bundling them, and the workflow run's log says why."],
+    ["failed without a reason", "failure", "the agent's job could not bundle them, and the workflow run's log says why."],
+  ] as const)("says the commits were not saved, and why, where the bundle step %s before it wrote anything", async (_name, outcome, why) => {
+    await run(INPUTS(AGENT("cancelled", { BUNDLE_OUTCOME: outcome })));
+
+    expect(writes()).toEqual(STOPPED_WRITES);
+    expect(comment()).toContain(unsaved(why));
+    expect(logged).not.toContain("No commits ahead of the base this run started from, so there is nothing to rescue.");
+  });
+
+  it("reads no bundle as no commits where the bundle step succeeded", async () => {
+    await run(INPUTS(AGENT("failure", { BUNDLE_OUTCOME: "success" })));
+
+    expect(comment()).toContain(`· ${RETRY}\n`);
+  });
+
   it("says the commits were not saved, and why, where the hand-over could not be fetched", async () => {
     await run(INPUTS(AGENT("failure", { DOWNLOAD_OUTCOME: "failure" })));
 
diff --git a/tests/service/worker.test.ts b/tests/service/worker.test.ts
index c225a10..867e5bd 100644
--- a/tests/service/worker.test.ts
+++ b/tests/service/worker.test.ts
@@ -1953,6 +1953,22 @@ describe("the worker's implement job, where it stops", () => {
     expect(s.env("implement:conclude")).toMatchObject({ AGENT_RESULT: "cancelled", TIMED_OUT: "true", BUNDLE_DIR: s.env("implement:bundle")["OUTPUT_DIR"] });
   });
 
+  /**
+   * #270: a bundle step ended at its limit writes nothing, so conclude is
+   * told how it ended, as the step's outcome on Actions, rather than reading
+   * the missing bundle as no commits.
+   */
+  it.each([
+    ["stopped at its limit", { hangs: true }, "cancelled"],
+    ["failed", { exit: 1 }, "failure"],
+    ["succeeded", {}, "success"],
+  ] as const)("tells conclude the bundle step's outcome where it %s", async (_name, bundle, outcome) => {
+    const s = setup({ ...IMPLEMENT_ORDINARY, "implement:bundle": bundle }, { minuteMs: 5 });
+    await runJob(IMPLEMENT_JOB, s.edges);
+
+    expect(s.env("implement:conclude")).toMatchObject({ BUNDLE_OUTCOME: outcome });
+  });
+
   it("hands conclude no loop token, so it rescues nothing, where the push token was refused", async () => {
     const s = setup({ ...IMPLEMENT_ORDINARY, implement: { exit: 1 } }, { refused: [4] });
     await runJob(IMPLEMENT_JOB, s.edges);
diff --git a/tests/workflows.test.ts b/tests/workflows.test.ts
index d4389a1..e062e59 100644
--- a/tests/workflows.test.ts
+++ b/tests/workflows.test.ts
@@ -5025,7 +5025,10 @@ describe("implement's agent job runs implement:prepare and implement:bundle from
     expect(index("Bundle the branch")).toBeGreaterThan(index("Upload the session transcript"));
     expect(index("Bundle the branch")).toBe(index("Hand the branch to the publish job") - 1);
     expect(index("Measure how the agent's job ended")).toBe(steps().length - 1);
-    expect(job().outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
+    // How the bundle step ended, set by Actions rather than the agent, so a
+    // bundle stopped before it wrote anything is not read as no commits (#270).
+    expect(bundle?.id).toBe("bundle");
+    expect(job().outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}", bundled: "${{ steps.bundle.outcome }}" });
     expect(bundle?.["working-directory"]).toBe("${{ runner.temp }}");
     expect(bundle?.env).toMatchObject({
       NPM_CONFIG_USERCONFIG: "${{ steps.npmrc.outputs.userconfig }}",
@@ -5085,7 +5088,8 @@ describe("implement's agent job runs implement:prepare and implement:bundle from
       TIMEOUT_MINUTES: "${{ vars.AGENT_TIMEOUT_MINUTES || '30' }}",
     });
     expect(outcome?.run).toBe(jobNamed(path.join(WORKFLOW_DIR, "fix.yml"), "fix").steps?.at(-1)?.run);
-    expect(job().outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
+    // Beside how the bundle step ended (#270), which the bundle's test holds.
+    expect(job().outputs).toMatchObject({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
   });
 });
 
@@ -7991,7 +7995,7 @@ describe("a run that times out or is cancelled says so, as a failure does", () =
       TIMEOUT_MINUTES: AGENT_MINUTES,
     });
     expect(outcome?.run ?? "").toContain("TIMEOUT_MINUTES * 60 - 60");
-    expect(jobNamed(fileOf(command), command).outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
+    expect(jobNamed(fileOf(command), command).outputs).toMatchObject({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
     expect(failureStep(command).env?.["TIMED_OUT"]).toBe(`\${{ needs.${command}.outputs.timed-out }}`);
   });
 
@@ -9220,7 +9224,15 @@ describe("a split run keeps every write off the agent's runner", () => {
     // and implement-prd's (#505): whether its job ran out of time, which only
     // that job can measure, as review's job does, and which picks between two
     // sentences of a stopped run's comment and decides nothing else.
-    if (file.endsWith("fix.yml") || file.endsWith("update-branch.yml") || file.endsWith("implement.yml") || file.endsWith("implement-prd.yml")) {
+    // Implement's second (#270): how its bundle step ended, which picks
+    // between "no commits" and "not saved" where there is no bundle, and
+    // rescues nothing either way.
+    if (file.endsWith("implement.yml")) {
+      expect(jobNamed(file, agent).outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}", bundled: "${{ steps.bundle.outcome }}" });
+      expect(text.match(new RegExp(`needs\\.${agent}\\.outputs\\.[\\w-]+`, "g"))).toEqual([`needs.${agent}.outputs.timed-out`, `needs.${agent}.outputs.bundled`]);
+      return;
+    }
+    if (file.endsWith("fix.yml") || file.endsWith("update-branch.yml") || file.endsWith("implement-prd.yml")) {
       expect(jobNamed(file, agent).outputs).toEqual({ "timed-out": "${{ steps.outcome.outputs.timed-out }}" });
       expect(text.match(new RegExp(`needs\\.${agent}\\.outputs\\.[\\w-]+`, "g"))).toEqual([`needs.${agent}.outputs.timed-out`]);
       return;
@@ -11214,9 +11226,10 @@ describe("implement's publish job publishes the PR with implement:publish and en
 
     expect([...new Set([...set, ...optional])].sort()).toEqual(Object.keys(declared).sort());
     for (const input of set) expect(declared, input).toHaveProperty(input);
-    // Only whether it timed out comes from the agent's job, and only to conclude.
+    // Only whether it timed out and how its bundle step ended (#270) come
+    // from the agent's job, and only to conclude.
     const agentOutputs = JSON.stringify(step?.env ?? {}).match(/needs\.implement\.outputs\.[\w-]+/g) ?? [];
-    expect(agentOutputs).toEqual(which === "conclude" ? ["needs.implement.outputs.timed-out"] : []);
+    expect(agentOutputs).toEqual(which === "conclude" ? ["needs.implement.outputs.timed-out", "needs.implement.outputs.bundled"] : []);
   });
 
   it("hands implement:publish the gate's facts and its directories", () => {
@@ -11264,6 +11277,7 @@ describe("implement's publish job publishes the PR with implement:publish and en
       MINT_OUTCOME: "${{ steps.token.outcome }}",
       DOWNLOAD_OUTCOME: "${{ steps.fetch.outcome }}",
       PUBLISH_OUTCOME: "${{ steps.publish.outcome }}",
+      BUNDLE_OUTCOME: "${{ needs.implement.outputs.bundled }}",
     });
     // Each prerequisite of conclude runs `always()` too, so it never reads an empty workspace.
     for (const step of steps().slice(0, at)) {
```

2. The commit message I would have written:

```text
fix(implement): say a stopped bundle step's commits went unsaved (#270)

Addresses review 2's finding on service/worker.ts: an `implement:bundle`
ended before it wrote anything left no `branch.bundle` and no reason file,
so `implement:conclude` read it as a run with no commits and posted the
plain retry.

The class is "a bundle step that ended without writing a file", and it has
three members: stopped at the worker's `BUNDLE_MINUTES`, cancelled on
Actions (a second cancel, or the job's grace window running out during the
`always()` step), and failed before the command could write its reason
(for example `npm exec` dying). Each is now covered by a new conclude
input, `BUNDLE_OUTCOME`, the bundle step's outcome. Actions sets it
itself, not the agent, as the agent job's `bundled` output
(`steps.bundle.outcome`). The worker passes cancelled, failure or success
from the run it already has. With no bundle, `cancelled` says the agent's
job was stopped before it finished bundling them, and `failure` gives the
existing "could not bundle them" clause. Both have tests, in conclude and
in the worker, and the workflow tests now hold the new job output and its
one reader. Spec row, rescue paragraph and Actions/service blocks updated.

This is the third round in rescueCommits on the same cause (round 1's
unsaved cases, then this one): a missing file was being read as "none".
Since this change, conclude reads "none" only from a bundle step that it
was told succeeded, or from an outcome it was not given at all.

Left as is: the worker still turns a timed-out bundle into the agent's job
`cancelled`, with the generic cancel reason. Fix and implement-prd map it
the same way, and the comment now says the commits were not saved because
the bundle step was stopped, which tells the reader what happened.

Verify: everything passes apart from the 12 "local caller passes only what
the release it pins declares" tests. They read `git show v0.9.2:...`, this
checkout has no tags, and they fail the same way without this change.
```

3. The thread's outcome: **addressed**. The reply I would post:

> Fixed in 107ddc9. `implement:conclude` now gets `BUNDLE_OUTCOME`: on Actions from the agent job's new `bundled` output (`steps.bundle.outcome`), on the service from the bundle run itself. Where there is no bundle, `cancelled` says the job was stopped before it finished bundling the commits, and `failure` says it could not bundle them. This covers the limit, a cancel, and a failure before the reason file is written, each with a test. I kept the cancelled-reason mapping, which fix and implement-prd share, but the comment now says the commits were not saved and why.
