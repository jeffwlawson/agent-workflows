# How gh-aw's safe outputs model a write

Research for #394, under the map #393. It reads GitHub Agentic Workflows' **safe outputs** as prior
art for the loop's write list: the loop decides a typed list of writes, and the engine applies it
with the write token, outside the agent's sandbox ([ADR 0002](./adr/0002-engine-and-loop-one-repo.md)).
We build beside gh-aw, not on it (ADR 0001, #388). This is about borrowing its write model.

`docs/landscape.md` §3 already established that gh-aw has the same credential split as this loop
and a safe output for nearly every write the loop makes. This document does not repeat that. It
goes one level down: what one write looks like, how it is capped, how it crosses from the agent to
the writer, what a failure does, and where `review.yml`'s posting steps fit and do not.

**Checked 2026-10-07**, against `github/gh-aw` at commit
[`bad24e3`][src] (committed that day). The docs were read from the repository's own source,
`docs/src/content/docs/`, at that commit. The hosted pages at `github.github.com/gh-aw` are built
from it, but a spot check showed the hosted safe-outputs page lagging the source on one paragraph,
so a link below names both. gh-aw is a public preview that tags several releases a week; re-read a
claim before building on it.

Where gh-aw's own **specification** and its **code** disagree, this document says so and follows
the code. Where a point was inferred rather than read, it says **inferred**.

---

## The answer in brief

1. **One write** is one JSON object with a `type` and that type's fields. The agent makes it by
   calling an MCP tool named after the type. A local server validates the call and appends a line
   to an NDJSON file, which an ingestion step in the agent's own job re-validates, caps and
   sanitises into `agent_output.json`: `{items, errors}`. The writer's configuration does not
   come from the agent at all. The compiler bakes it into the writing job as an environment
   variable.
2. **Limits** are per type: a `max` count, a `target` (the triggering item, a fixed number, or any
   item), repository allowlists, label allow and block globs, and pre-conditions on the target
   (`required-labels`, `required-title-prefix`). The specification says a list over `max` is
   rejected whole. The code keeps the first `max` items and drops the rest, at three separate
   layers.
3. **The job split** is agent (read-only) → detection (read-only, runs a model) → one consolidated
   `safe_outputs` job holding the union of the write scopes its configured types need → a
   `conclusion` job, which handles failure and status. Items cross from agent to writer as an
   Actions **artifact**, never as job outputs.
4. **Failure** is per item, not all-or-nothing. Each item is applied in order. A failed item does
   not stop the rest, and the job fails at the end if any item failed. One exception batches: the
   review and its inline comments are buffered and posted as one review at the end, and roll back
   together. A failed run's list can be **replayed** from its artifact.
5. **The fit:** the review, inline comments, thread resolution, labels, marking ready, PR body
   edits and comments all have a type. Five kinds of write in `review.yml` have nothing equivalent: the
   **commit status** (gh-aw has check runs only), the **resolution reason** on a resolved thread,
   a **reply addressed by thread id** and coupled to the resolve, a write whose content depends on
   **what an earlier write did** (the review body's *Resolved* list), and writes **decided at apply
   time from live state** (re-requesting a review when the head moved, the fix-round guard). Its
   failure path is also outside the list in gh-aw, in the `conclusion` job.

What bears on the next tickets is collected at the end, in [For #396–#398](#for-396398).

---

## 1. The shape of one write

### Declared in frontmatter, typed by a generated schema

A workflow enables a type by naming it under `safe-outputs:` with its options, such as
`add-labels: {allowed: [...], max: 3}`. At compile time gh-aw generates, from the enabled types,
two things. One is an **MCP tool schema** per type, which is what the agent sees. The other is a
**handler configuration** per type, which is what the writer enforces
([spec §4.2, phases 1–2][spec]). The tool schemas live in
[`actions/setup/js/safe_outputs_tools.json`][tools]. `submit_pull_request_review`, for example, takes
`body` (≤ 65,536 characters), `event` (`APPROVE`, `REQUEST_CHANGES` or `COMMENT`), and an optional
`pull_request_number` and `repo`, with `additionalProperties: false`.

Tool descriptions carry the constraints, so the model can stay inside them. The spec requires it
(MCE2). The review tool's description, for instance, tells the agent not to call it to probe its
schema.

### What the agent emits

The agent calls the tool, for example `resolve_pull_request_review_thread` with
`{"thread_id": "PRRT_..."}`. The safe-outputs MCP server runs beside the agent with no GitHub access
([spec §3.1][spec]). It validates the arguments, enforces a type's explicit `max` (refusing the
call with `E002: <type> limit reached`), and appends one line, `{"type": "<type>", ...fields}`, to
an NDJSON file ([`safe_outputs_handlers.cjs`][handlers] `enforcePerTypeMax`;
[`safe_outputs_append.cjs`][append]).

The agent learns at once when it broke a rule, because the call fails while it can still correct
itself ([spec §8.3][spec], MCE1).

### What is handed over

After the agent finishes, an **"Ingest agent output"** step in the agent job runs
[`collect_ndjson_output.cjs`][collect]. It re-parses each line, normalises the type (dashes to
underscores), rejects types the workflow did not enable, applies `max` again, validates fields,
and sanitises text. It writes `/tmp/gh-aw/agent_output.json`:

```json
{ "items": [ { "type": "add_labels", "labels": ["bug"] } ], "errors": ["Line 4: Too many items of type 'add_labels'. Maximum allowed: 1."] }
```

That file, the raw NDJSON and any patch are uploaded in the `agent` artifact (the `Upload agent
artifacts` step in, for example, [`pr-code-quality-reviewer.lock.yml`][lock]).

The writer's configuration does **not** travel with the items. It is compiled into the writing
step as `GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG`, a JSON literal in the lock file:
`{"submit_pull_request_review":{"allowed_events":["COMMENT","REQUEST_CHANGES"],"max":1}, ...}`. So
the agent supplies *what* and the workflow's author fixes *how much and where*. Nothing the agent
writes can widen its own limits.

### Things one write can carry besides fields

- **Temporary ids.** An item can name itself `aw_<id>`, and a later item can refer to it, for
  example creating an issue and then linking it as a sub-issue. The processor sorts items by these
  dependencies, defers an item whose reference is not yet resolved, and retries it after the first
  pass ([`safe_output_handler_manager.cjs`][manager] `processMessages`,
  `sortMessageIndicesByTemporaryIdDependencies`).
- **Provenance.** Posted text gets a footer and a hidden marker naming the workflow, so later runs
  can find and supersede their own output (`footer`, `hide-older-comments`,
  `supersede-older-reviews`; [reference][ref]).
- **Custom types.** `safe-outputs.jobs` (a separate job that reads `$GH_AW_AGENT_OUTPUT` and loops
  over `.items[]`), `safe-outputs.scripts` (inline JavaScript run once per item inside the writing
  job) and `safe-outputs.actions` (a pinned public action mounted as a once-callable tool)
  ([custom safe outputs][custom]). This is how gh-aw covers a write it has no type for.

---

## 2. Limits and caps

### What can be limited

| Control | What it does | Source |
|---|---|---|
| `max` | Count of items of one type per run. Defaults are per type: 1 for `submit-pull-request-review`, 10 for `resolve-pull-request-review-thread` and review comments, 5 `add_labels` calls with `max-labels` 10 each. `-1` is unlimited. May be an expression evaluated at runtime | [reference][ref]; [spec TS1][spec] |
| `target` | `"triggering"` (default): only the item that started the run. A number: only that item. `"*"`: any item, named by the agent per call | [reference][ref]; [spec RPT-001–005, MRR-001–005][spec] |
| `target-repo`, `allowed-repos` | Cross-repository writes, fixed or from an allowlist. Review types refuse the `"*"` wildcard | [reference, Cross-Repository Operations][ref] |
| `allowed` / `blocked` | Label globs. `blocked` is checked first and wins, so `~*` can keep an agent off trigger labels however wide `allowed` is | [reference, Blocked Label Patterns][ref] |
| `allowed-events` | Which review decisions may be submitted | [PR reference][refpr] |
| `required-labels`, `required-title-prefix` | Pre-conditions on the target: write only if it carries all these labels or this title prefix | [reference][ref] |
| `allows-comment-ids` | Which existing comments the agent may edit, from trusted workflow state rather than the agent | [reference, add-comment][ref] |
| Text constraints | Length, mention and link limits per field, enforced at the tool call and again in the writer (MCE4) | [spec §8.3][spec] |

The spec makes the target check a runtime authorisation the schema cannot replace: a resolve on
`"triggering"` looks up the thread's pull request and refuses it unless that is the triggering one
([spec RPT-002, RPT-005][spec]; [`resolve_pr_review_thread.cjs`][resolve]
`getThreadPullRequestInfo`).

### What happens over a cap: the spec and the code disagree

The specification says a type over its `max` is rejected **whole**, before any API call, "not just
excess operations", so the run never applies half a list ([spec §6.1, MR2–MR3][spec]).

The code does not do that. **Read in code**, at all three layers it keeps the first `max` items and
drops the rest:

1. The MCP server refuses the call that would exceed an explicitly configured `max`
   ([`safe_outputs_handlers.cjs`][handlers] `enforcePerTypeMax`).
2. Ingestion skips each line past `max` and records `Too many items of type ...` in `errors`
   ([`collect_ndjson_output.cjs`][collect], the per-line loop).
3. Each handler counts what it has processed and fails each item past `max` with `Max count of N
   reached` ([`resolve_pr_review_thread.cjs`][resolve] `handleResolvePRReviewThread`; the same
   pattern in the other handlers).

So in practice a cap **truncates** rather than voids. That is worth knowing before copying either
behaviour. All-or-nothing is safer for a list where the items only make sense together. First-N
suits independent items.

---

## 3. The job split, the hand-over, and where threat detection sits

### The jobs and what each holds

Read from the compiler ([`pkg/workflow/compiler_safe_outputs_job.go`][jobgo]) and one compiled lock
file, [`pr-code-quality-reviewer.lock.yml`][lock], whose source enables
`create-pull-request-review-comment` and `submit-pull-request-review`:

| Job | Permissions in that lock file | Does |
|---|---|---|
| `pre_activation` | `contents: read`, `pull-requests: read` | Checks the command and the actor's team membership |
| `activation` | `issues: write`, `pull-requests: write` (plus reads) | Posts the "started" comment and reaction, renders the prompt |
| `agent` | `contents: read`, `issues: read`, `pull-requests: read`, `copilot-requests: write` (inference) | Runs the agent behind the firewall, ingests and caps its items, uploads the `agent` artifact |
| `detection` | `contents: read`, `copilot-requests: write` | Downloads the artifact, runs the threat model, outputs a conclusion |
| `safe_outputs` | `checks: write`, `issues: write`, `pull-requests: write` | Applies every item, in one `Process Safe Outputs` step |
| `conclusion` | `issues: write`, `pull-requests: write`, `checks: write` | Runs `always()`: no-op messages, the failure issue or comment, the final status comment |

Two things here differ from what the docs suggest:

- **One writing job, not one per type.** The spec still says jobs "SHOULD specialize by operation
  type" (AR3) and its compiler component "synthesize[s] dedicated jobs for each safe output type"
  ([spec §3.1, §4.1][spec]). The code builds a single job "containing all safe output operations as
  separate steps", with the union of the scopes the enabled types need
  (`buildConsolidatedSafeOutputsJob`, `ComputePermissionsForSafeOutputs` in [`compiler_safe_outputs_job.go`][jobgo]).
  In the lock file that is one step that dispatches every item to its handler
  ([`process_safe_outputs.cjs`][process] → [`safe_output_handler_manager.cjs`][manager]).
- **The framework writes too, outside the list.** `activation` and `conclusion` hold write scopes
  and post the run's own status, failure reports and no-op messages. Those writes are not items an
  agent emitted. They are the workflow's bookkeeping.

### The hand-over

Items cross jobs **only as an Actions artifact**. The spec makes that normative: not job outputs,
not environment variables, not a shared filesystem (AR2, [spec §3.1][spec]). `safe_outputs`
downloads the `agent` artifact and points `GH_AW_AGENT_OUTPUT` at `agent_output.json`. The small
results go back out as job outputs: `items_applied`, `items_failed`, `created_issue_number`,
`comment_url` and so on ([`compiler_safe_outputs_job.go`][jobgo] `addHandlerManagerOutputs`). That
is the same split this loop already uses: the bundle as an artifact for size, the decisions as
outputs (`review.yml`, *Hand the review to the posting job*).

After applying, `safe_outputs` uploads a manifest of what it did: `safe-output-items.jsonl`,
`temporary-id-map.json` and `safe-output-errors.json` (`Upload Safe Outputs Items` in the lock
file).

### Where threat detection sits

Between the agent and the writer, as its own job ([threat detection][td]). It downloads the same
artifact and runs a model over the items, the patch and the prompt, asking for
`{prompt_injection, secret_leak, malicious_patch, reasons}`. It can also run your own steps before
and after, which see `/tmp/gh-aw/threat-detection/agent_output.json` and `aw.patch`.
`safe_outputs` has `needs: [activation, agent, detection]` and
`if: ... && needs.detection.result == 'success'` ([`expression_builder.go`][expr]
`buildDetectionSuccessCondition`).

What a detected threat does depends on `continue-on-error`, **which defaults to true**
([`threat_detection_config.go`][tdconfig] `IsContinueOnError`):

- **Strict** (`continue-on-error: false`): the detection job fails, the `if:` above is false, and
  **nothing** in the list is applied.
- **Warn** (the default): the detection job stays green with `detection_conclusion=warning`, and
  `safe_outputs` runs. The handler manager then applies a policy per type
  ([spec §10.5][spec]; [`safe_output_handler_manager.cjs`][manager] `getThreatWarningPolicy`).
  - **Reviewable** types are posted with a caution banner and a marker. These include
    `submit_pull_request_review`, `add_comment` and `update_pull_request`.
  - **Abort** types are dropped as cancelled. These include `add_labels`, `remove_labels`,
    `resolve_pull_request_review_thread`, `mark_pull_request_as_ready_for_review` and
    `dispatch_workflow`.
  - `push_to_pull_request_branch` is **converted** into a new pull request.

  **Inferred:** that a real threat verdict in warn mode concludes as `warning`, not `failure`. The
  conclusion itself is computed by the external `threat-detect` binary, which this research did
  not read. The handler manager's warning branch and spec §10.5 both assume it.

So the threat-detection docs' "safe outputs are blocked" describes strict mode. By default, gh-aw
lets the text through, annotated, and stops the state changes. That split is a ready-made answer to
"what may still be posted when the scan is unsure", and #392 may want it.

---

## 4. Failure: per item, with one batch

Read from `processMessages` and `main` in [`safe_output_handler_manager.cjs`][manager] and
[`safe_outputs_status.cjs`][status]:

- **Order.** Items are applied in the order the agent emitted them, re-sorted only so that a
  temporary id is created before it is used. The spec adds that the system types (`noop`,
  `missing_tool`) come last ([spec §10.2][spec]).
- **Per item.** Each item is handled alone and gets an outcome: `success`, `skipped`, `warning`,
  `cancelled`, `deferred` or `failed`. A failure is recorded and processing **continues** ("one
  operation's failure doesn't prevent others from attempting", [spec §10.4][spec]). There is no
  rollback of an applied item.
- **Job result.** If any item failed, the step calls `setFailed`, after everything has been
  attempted. The exceptions are `assign_to_agent`, `upload_artifact` and `upload_code_coverage`,
  whose failures are reported but do not fail the job (`REPORT_ONLY_FAILURE_TYPES`). The overall
  status is exported as `success`, `partial_success`, `failure`, `completed_with_skips` and so on.
- **Fail-fast for code.** If a push or a pull-request creation fails, later `add_comment` bodies get
  a note prepended saying the code was not applied, so a comment does not claim a change that never
  landed.
- **The batch.** `create_pull_request_review_comment` and `submit_pull_request_review` only
  **buffer** during the loop and return success. After the loop, one `pulls.createReview` call per
  pull request posts the review with all its inline comments. If that call fails, every buffered
  review item for that pull request is re-marked failed (`rollbackReviewResultsForPR`;
  [`pr_review_buffer.cjs`][buffer]). The review is pinned to the head SHA at trigger time, not the
  head at posting time, unless configured otherwise (`commit_id`, `GH_AW_HEAD_SHA`).
- **Soft skips.** Some refusals count as a skip with a warning, not a failure. One example is
  `resolveReviewThread` answering `Resource not accessible by integration`
  ([PR reference][refpr], *Integration-token limitation*).
- **Replay.** A failed or skipped `safe_outputs` job can be re-run later from the original run's
  `agent_output.json` by the generated *Agentic Maintenance* workflow, if the actor has `admin` or
  `maintain` ([reference, Replaying Safe Outputs][ref]). This is the payoff of handing over a list
  instead of acting inline: the decision outlives the run that made it.
- **Staged mode.** `staged: true`, set globally or per type, applies nothing and writes a preview of
  every item to the step summary ([reference, Staged Mode][ref]).

In short: **not all-or-nothing.** A list is a sequence of independent attempts with one buffered
batch, and a run that failed halfway is visible in its manifest and recoverable by replay.

---

## 5. The fit against `review.yml`

The rows below are every write in `review.yml`'s `post-review` and `advance` jobs, by step name, in
the order they run.

Two caveats apply to the whole table:

- **Who writes the list differs.** In gh-aw the **agent** emits the items. In this loop the
  **runner** emits them, as deterministic TypeScript reading the agent's output, so most of our
  items are loop-authored, not agent-authored. A gh-aw cap guards against a runaway agent. Ours
  would guard against a runner bug.
- **The record's strings are ours.** gh-aw's markers (`gh-aw-island-start:<workflowId>`, footers)
  are not this loop's (`<!-- agent:status -->`, `agent-review`). The record's shape does not
  change (#393), so only the mechanism maps, not the format.

| `review.yml` step | What it writes | gh-aw type | Gap |
|---|---|---|---|
| *Say why the review didn't run* | Refusal comment; remove `agent:review`; maybe add `agent:blocked` | `add-comment`, `remove-labels`, `add-labels` | Decided by the loop's guards before any agent ran. In gh-aw this is `conclusion`-job bookkeeping, not an item |
| *Transition labels* | Remove `agent:blocked` | `remove-labels` | None |
| *Resolve the threads this review closed* | Per thread: a reply by **thread id**, then `resolveReviewThread` with `resolutionReason` `ADDRESSED` or `WONT_FIX`. Skip the reply where `alreadyReplied`. Do not resolve if the reply failed. Record which resolved | `reply-to-pull-request-review-comment`, `resolve-pull-request-review-thread` | **No resolution reason** (the resolve handler sends `threadId` only). **Reply takes a numeric REST comment id**, not a thread id. **No coupling**: two independent items, so a failed reply does not stop the resolve |
| *Post PR review* | One `addPullRequestReview` with body and a thread per finding. The body's *Resolved* and *still open* groups are built from what the previous step actually resolved | `submit-pull-request-review` + `create-pull-request-review-comment`, buffered into one review | Close match for the one-call review. **No equivalent for a body computed from an earlier write's outcome.** gh-aw's nearest is the hard-coded note it prepends to comments after a failed push. A hard failure here writes `failure_reason.txt`, and gh-aw's job fails too |
| *Write the PR title and summary* | PATCH title and a marker-delimited block in the body; drop an old block; refuse half a block | `update-pull-request` with `operation: replace-island` | gh-aw's island markers are fixed to its own format and workflow id. Ours are the record's. No "drop another block" or "refuse on half a marker" |
| *Write the PR status line* | Splice a line between `<!-- agent:status -->` markers, with the review URL substituted | `update-pull-request` `replace-island` | Same as above, plus a **value only known after an earlier write** (the review URL). gh-aw's temporary ids cover created issues and PRs, not a review URL |
| *Mark the PR as carrying follow-ups* | Add `agent:follow-ups` | `add-labels` | None |
| *Post the verdict as a commit status* | `agent-review` status and, on a fix round, `agent-fix-round`, on the reviewed SHA | **none** (`create-check-run` is the nearest) | **No commit-status type.** A check run is a different object with a different API, and the fix-round budget counts statuses by context, creator and `target_url` (the record, §4 of `docs/platform-spec.md`). This is the clearest missing type |
| *Resolve the loop's token* | (token, not a write) | `github-token` / `github-app`, global or per type | gh-aw picks the token per type in config. Ours falls back App → PAT → `GITHUB_TOKEN` at runtime, and later steps **branch on which one it got** |
| *Mark PR ready for review* | `gh pr ready`, conditional on verdict, fix round and round kind | `mark-pull-request-as-ready-for-review` (in the spec and full frontmatter reference, not in the reference's summary table) | The condition is the loop's, not the agent's |
| *Post an error verdict* (failure path) | `agent-review` status `error` | none | Failure-path bookkeeping: gh-aw's `conclusion` job, not an item. And no status type anyway |
| *Mark blocked on failure* (failure path) | Failure comment; remove `agent:review`; add `agent:blocked` | `add-comment`, `remove-labels`, `add-labels` | Same: `conclusion`-job territory in gh-aw |
| *Always remove the trigger label* | Remove `agent:review`. Then, **reading live state**, re-add it if the head moved and no other loop label is on, only with an App or PAT token | `remove-labels`, `add-labels` | **Decided at apply time** from the live PR, not from the list. gh-aw's items are fixed when the agent emits them. Its `label_command` trigger removes its own label in `activation` |
| *Start the automatic fix round* | Reads statuses on the head; guards the round; removes and re-adds `agent:fix` | `add-labels` (or `dispatch-workflow` to chain) | **The guard reads live state at apply time.** Remove-then-add to re-trigger has no single type: `replace-label` swaps two different labels in one PUT ([replace-label spec][replace]) |
| `advance`: *Re-render the progress list* | Splice the PRD PR's progress block, picked by how the round ended | `update-pull-request` `replace-island` | Which file is used depends on how **this run's earlier jobs** ended |
| `advance`: *Advance the PRD chain* | Re-add `agent:implement` on the **parent issue** | `add-labels` with `target: "*"` | Needs a token whose label starts a workflow. gh-aw would configure that per type |
| `advance`: *Say the PRD chain did not advance* | Comment on the PRD PR | `add-comment` | Failure-path |
| `advance`: *Park the PRD chain* | Park comment on the parent issue, **falling back** to the PRD PR when the token cannot reach the issue | `add-comment` with `target: "*"` | **No fallback target.** gh-aw's only fallbacks are hard-coded for code pushes (`fallback-to-issue`) |

### Which of our writes have no gh-aw equivalent

- **A commit status.** No type sets one. Read in code: no handler calls the statuses API.
- **A resolution reason** on `resolveReviewThread`.
- **A reply by thread id coupled to its resolve**: resolve only if the reply landed, and retry only
  the resolve next time.
- **A write whose content is computed from earlier writes' outcomes**: the review body's resolved
  and open groups, and the review URL in the status line and park comment.
- **Writes decided at apply time from live state**: re-requesting the review when the head moved,
  the fix-round guard, and the park comment's fallback target.
- **Failure-path writes** (error verdict, blocked label, failure comment). gh-aw has these, but as
  framework bookkeeping in `conclusion`, outside the list.

---

## For #396–#398

This section is this document's reading of what the findings mean here. It is not a claim about
gh-aw.

- **The decide/apply split (#397).** gh-aw splits *who decides what* (the agent, per item) from
  *what bounds it* (compiled config the agent cannot see or widen). The analogue here is the
  **loop** deciding items and the **engine** owning the per-type bounds, so a loop bug cannot
  widen what the engine will do. But a third of `review.yml`'s writes are decided at apply time
  from live state, or from an earlier write's result. A list fixed before applying cannot hold
  them. Either the engine gains typed "conditional" items, which re-creates the logic in the
  engine, or the list is applied in phases with the loop deciding between them. **Inferred:** the
  phased shape fits better, since gh-aw itself needed a hard-coded special case (the note after a
  failed push) for the one place it met this.
- **Command shape (#396).** gh-aw's writer is one command over the whole list, dispatching by type
  to small handlers, each with its own config and count. It reports per-item outcomes and a
  manifest. A `publish`-style command over a typed list, with one handler per write type, maps onto
  that directly. The commit status would be our own type, as a custom type is in gh-aw.
- **The phase hand-over (#398).** gh-aw hands over by artifact only, with the bounds compiled into
  the writer rather than carried with the items. That matches what `review.yml` already does
  (artifact for the bundle, outputs for decisions). It also gives two things to borrow cheaply: an
  **applied manifest** uploaded after publish, and **replay** of a list from a failed run's
  artifact.
- **Caps.** Decide all-or-nothing versus first-N per type on purpose. gh-aw's own spec and code
  disagree on it.
- **Threat detection (#392).** gh-aw's detector sits between hand-over and apply, and its default
  is warn: post the text annotated, drop the state changes. That is a per-type policy table the
  write list could carry from the start.

[src]: https://github.com/github/gh-aw/tree/bad24e36c24e862bfbb2018be125298c48bccd00
[ref]: https://github.github.com/gh-aw/reference/safe-outputs/
[refpr]: https://github.github.com/gh-aw/reference/safe-outputs-pull-requests/
[td]: https://github.github.com/gh-aw/reference/threat-detection/
[custom]: https://github.github.com/gh-aw/reference/custom-safe-outputs/
[spec]: https://github.github.com/gh-aw/specs/safe-outputs-specification/
[replace]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/specs/replace-label-spec.md
[tools]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/safe_outputs_tools.json
[handlers]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/safe_outputs_handlers.cjs
[append]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/safe_outputs_append.cjs
[collect]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/collect_ndjson_output.cjs
[manager]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/safe_output_handler_manager.cjs
[process]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/process_safe_outputs.cjs
[status]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/safe_outputs_status.cjs
[resolve]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/resolve_pr_review_thread.cjs
[buffer]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/actions/setup/js/pr_review_buffer.cjs
[jobgo]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/pkg/workflow/compiler_safe_outputs_job.go
[expr]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/pkg/workflow/expression_builder.go
[tdconfig]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/pkg/workflow/threat_detection_config.go
[lock]: https://github.com/github/gh-aw/blob/bad24e36c24e862bfbb2018be125298c48bccd00/.github/workflows/pr-code-quality-reviewer.lock.yml
