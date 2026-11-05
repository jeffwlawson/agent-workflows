# Seeing what the self-hosted loop is running: options for one owner

Research for the maintainer, 2026-11-03. Repo lines are from `origin/main` at commit
`7902e1b99b1d8dc23c5de574d2c4c0f469680c71`, read with `git show origin/main:<path>` (no checkout
was touched). Every claim carries a source: a repo `file:line`, or a URL fetched on this date.
Anything not confirmed from a primary source is marked **UNVERIFIED**. Nothing here was run against
a real machine: I did not ssh to, probe or otherwise touch the Unraid server or the agent box, and
every statement about how they behave comes from the repo's docs and code.

This is a long-term, low-priority options survey, not a build request. Nothing in it is a decision.

Short forms: `DS` = `docs/deploying-the-service.md`; `CTX` = `CONTEXT.md`. Other paths are written
out.

---

## 0. The answer in brief

1. **Most of "what is running" is already on GitHub, as labels.** A trigger label is on an item
   while its run works or is queued behind another (CTX:158-160), and a failure leaves `agent:blocked`
   and a comment saying why (CTX:172-181). What GitHub cannot say is the difference between running,
   queued and waiting out a usage limit, how long a job has run, and whether the service is alive.
2. **The service holds that information and shows none of it.** The worker knows each job's state
   (`queued`, `light`, `waiting`, `agent`) in memory (`service/worker.ts:2537`), but its held door
   answers only id, kind, repository and number (`service/job.ts:440-446`, `service/worker.ts:2475`).
   The usage-limit hold is in the worker's memory and nowhere else the service can read
   (`service/worker.ts:2565-2574`, DS:806-812). The dispatcher never learns that a job ended
   (section 2).
3. **Any status view that lives in the dispatcher dies with it.** Two things survive a dead
   dispatcher or a dead host: GitHub's own record (stale, but present) and a check that runs
   somewhere else. The one cheap thing worth having on another machine is a heartbeat that raises an
   alarm when it stops (option 4).
4. **Recommended first step:** a read-only `deploy/unraid/status.sh`, in the style of `runs.sh` and
   `check-unraid.sh`, that prints the container's state, what the worker holds, and what the
   dispatcher's state file records, and that still works with the dispatcher stopped (section 7).
   No new port, no new permission, no change to the running service.

---

## 1. Corrections to the brief

The setup description is right in outline. These points differ in a way that matters here.

| The brief says | The repo says | Source |
|---|---|---|
| A signed "held door" endpoint "reports what it holds" | It is a `POST`, signed with `WORKER_SECRET`, and answers each held job's id, kind, repository and number only. No queued/running distinction, no lane, no hold. `GET` on that port answers `/health` and nothing else | `service/worker.ts:2439-2476`, `service/job.ts:440-446,479`, `service/serve.ts:62,287-292` |
| One job at a time per lane | Correct, and there are **two** lanes (agent, light), so up to two jobs run at once, one of each | DS:476-501 |
| Status comments carry a "Workflow run" link `.../apps/<slug>#job-<id>` | Only implement, implement-prd and follow-ups comments carry it. "Review, fix and update-branch post no run link on the service." The link opens the App's page, not a run | DS:670-675, `service/worker.ts:255` |
| A usage-limit hold is kept as a note on the item and in the worker's agent lane | Correct. The lane's hold is **in the worker's memory only**; a restarted worker forgets it and no longer announces the reset | DS:806-812, `service/worker.ts:2565-2574` |
| The Actions tab no longer shows the loop | Nearly. On a service repository "each label still starts a caller run, and every job in it skips", so the tab shows runs that say nothing | `docs/ADOPTING.md:548-551`, `docs/ADOPTING.md:536` |
| The dispatcher keeps a state file of dispatched jobs and scan counts | Correct. It holds per job: id, repo, deadline, kind, number, `posted`, `scanned`, `order`. No start time, no state, no end. Written on change, read once at start, no secrets | `service/dispatcher-state.ts:4-19,25-45,55-80`, DS:310-322 |
| A webhook reaches a Tailscale Funnel to the dispatcher | Correct. Funnel publishes only the webhook door (`127.0.0.1:8790`, public port 10000). The token door is `192.168.250.1:8791`; the worker is `192.168.250.11:8787` | DS:826-836,907-925,954-961 |
| PR bodies carry a status block | Confirmed in code (`statusBlock(OPENING_STATUS)` in the PR frame). I did not read what the block says over a PR's life | `shared/pr-frame.ts:44-46,58` |

---

## 2. What status information exists today

| Signal | Where it lives | What it says | Survives |
|---|---|---|---|
| Trigger label on an item | GitHub | A run is working or queued for it (CTX:158-160). On an open PR `agent:follow-ups` is a marker and `agent:merge` a standing decision, so neither means running (DS:341-343, DS:358-361) | Any outage (stale) |
| `agent:blocked` plus a `stopped:` / `didn't run:` / `is waiting:` comment | GitHub | A run failed or was refused; or it waits on the plan's usage limit and resumes after a stated UTC time (CTX:172-181, `shared/record.ts:323,694`) | Any outage |
| `agent-review`, `agent-fix-round`, `agent-merge` commit statuses | GitHub, per head commit | The verdict, a fix round asked for, the maintainer's arm (`shared/record.ts:238,255-259,270`) | Any outage |
| PR body status block, "Workflow run" link | GitHub | Where an implement chain stands (`shared/pr-frame.ts:44-60`) | Any outage |
| App "Recent Deliveries" | GitHub App settings page | Each webhook delivery and the dispatcher's HTTP answer, `202` or `401` (DS:183-185). The same list is readable with an App JWT at `GET /app/hook/deliveries` (`docs/installability.md:522`) | GitHub |
| Dispatcher's `jobs` map, `asks` counts | Dispatcher memory, mirrored to `STATE_FILE` | Jobs posted to the worker and items at the scan limit (`service/dispatcher.ts:554`, DS:310-322) | State file survives a restart; the map does not without it |
| Worker's queue, lane state, usage-limit hold | Worker memory | Everything the held door omits (`service/worker.ts:2531-2540,2565-2574`) | Nothing: lost on a worker restart (DS:799-812) |
| Worker log | `journalctl -u agent-worker` in the agent box | One line per job, e.g. `job <id>: ended. <phase>: <outcome>; ...` (`service/serve.ts:246`); free text with an ISO timestamp (`service/serve.ts:89`) | The box's journal |
| Dispatcher log | `docker logs agent-dispatcher` | Every delivery with its reason, every scan line starting `scan:` (DS:236, DS:415-416) | The container's log |
| `WORK_DIR/runs/<start>-<job>/summary.json` | Agent box disk | The job, each phase's outcome, each subcommand's environment, tokens redacted. Never pruned (`service/worker.ts:437-466`, DS:662-668) | The box's disk |
| `runs.sh` | Run on the box as root | The last N runs, newest first, one line each; `runs.sh <id>` prints one in full; lists a run with no summary as such (DS:677-685, `deploy/unraid/runs.sh:1-25`) | Needs the box up |
| `check-unraid.sh`, `check-box.sh` | Run by hand | Config and health checks; each door's `/health`; counts of failure lines in the logs (`deploy/unraid/check-unraid.sh:1-13,175,251`, `deploy/unraid/check-box.sh:144,220`) | Needs the machine up |

Two facts shape every option below.

- **The dispatcher cannot see a job end.** It learns of a job when it posts it and of its phases
  from token requests (`service/dispatcher.ts:993-1005`). It forgets a job only when a later scan
  finds the worker no longer holds it (DS:384-386, `service/dispatcher.ts:1024-1048`), and a scan is
  skipped while the worker cannot be reached (DS:373). So "just finished" has no source inside the
  dispatcher today.
- **Where a signal can come from is limited by the network.** The agent box's firewall allows it the
  DNS server, DHCP and the token door; its proxy allowlists GitHub, the model's API and the package
  registries by hostname (DS:855-856,897-905). The worker therefore cannot reach a notification
  service without a change to the proxy; the dispatcher on Unraid can.

### The four questions, against today's record

| Question | Answered now by | Not answered |
|---|---|---|
| What is running? | A trigger label on an item; `journalctl`; `runs.sh` for a run that has written a summary | Which job is actually running vs queued; how long; for an implement job, nothing at all until its start comment |
| What is queued? | A trigger label (no order) | Order, lane, the wait; the held door has the order but nothing reads it for a human |
| What is blocked or waiting? | `agent:blocked` and comment; the `is waiting:` comment with a reset time | Whether the worker is still holding the lane; the hold is invisible outside the worker. A dead worker looks the same as a queued job (label on either way) |
| What just finished? | PR comments, labels removed, statuses on GitHub; `runs.sh` | A single list across repositories |

---

## 3. The options at a glance

Costs are rough, in lines of TypeScript or shell including tests, and mine: nothing was built.
"If dispatcher is down" is the question the brief asks: what stays visible.

| # | Option | Shows | Build in this repo | New exposure | If dispatcher is down | Fit for one owner |
|---|---|---|---|---|---|---|
| 0 | Saved GitHub search, `gh` script, Recent Deliveries | Items carrying trigger labels; delivery failures | Zero code; a paragraph of docs | None | Works; stale labels; failed deliveries show the outage | Good baseline, not live |
| 1 | Tailnet-only status page/JSON on the dispatcher | Jobs, order, lanes, hold, worker reachable, items at limit | M, 250-400 lines, 6-8 files | Repo names and item numbers, to the tailnet | Dies | Best for "running / queued" |
| 2 | Prometheus + Grafana (+ Unraid container health) | History and alerts over the same data | S-M in repo (150-250), plus operator setup | As option 1 | Prometheus `up == 0` fires; history stays | Heavy for one owner unless already run |
| 3a | A check run or status per job | In-progress marker on the PR | M-L, 200-400, touches the merge gate | New App permission for check runs | Stale marker stays | Poor; couples to CI logic |
| 3b | Pinned status issue | One page of rows, on GitHub | M, 150-250 | Repo names on GitHub (private repo needed) | Stale, says so only if told to | Fair; phone friendly |
| 3c, 3d | Projects board; deployments | Cards; environments | L | New App permissions | Stale | Not recommended |
| 4 | Push alerts plus an off-box heartbeat | "Needs you" and "stopped" | S-M, 150-250 | Repo names and numbers leave the house | Heartbeat alarm is the only thing that works | Best for "what is not running" |
| 5 | Log viewer (Dozzle, Loki) | Log text | S (Dozzle: no code) | docker socket, or log shipping | Last lines remain | Debug aid, not status |
| 6 | CLI over the held door (status.sh) | Same as option 1, on demand, from Unraid's shell | S, 80-150 bash | None | Can be made to work with the dispatcher stopped | Good first step |
| 7, 8 | What other runners and agent projects do | (Survey) | | | | Source of vocabulary |

---

## 4. Per-option detail

### Option 0. What GitHub already gives, with no build

- **What it shows.** Open items that carry a trigger label: that is "running or queued" by the
  loop's own rule (CTX:158-160). `agent:blocked` is "needs you". A search must leave out
  `agent:merge` on an armed PR (a standing decision, DS:358-361) and `agent:follow-ups` on an open
  one (a marker, DS:341-343) or it lists healthy items.
- **Delivery liveness.** GitHub's Recent Deliveries lists each webhook and the dispatcher's answer
  (DS:183-185). A dispatcher that is down answers nothing, so failed deliveries are the earliest
  GitHub-side sign of an outage. That a down dispatcher shows as failed deliveries is my inference;
  the docs describe only the `202` and `401` answers. GitHub does not redeliver on its own
  (DS:282-283).
- **Cost.** None in the repo. A `gh search issues` / `gh search prs` script is about 40 lines; its
  syntax for OR-ing labels is **UNVERIFIED** (I did not fetch GitHub's search docs).
- **Exposure.** None new. Rate limit: an installation token gets at least 5,000 requests an hour,
  and content-creating requests are held to about 80 a minute
  (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api); a read-only
  poll every few minutes is far under it.
- **Down.** Works in every outage, because it is GitHub. Its defect is that a label on an item
  reads the same whether the job is queued, running, or abandoned by a dead worker. The scan
  repairs this at the next start (DS:388-397), not before.
- **Fit.** A free baseline. It cannot say "alive".

### Option 1. A read-only status endpoint on the dispatcher, over the tailnet

- **What it shows.** From the dispatcher's own records: the jobs it posted (id, repository, item,
  kind, deadline), the items at the scan limit and so "left for a person"
  (`service/dispatcher-state.ts:37-45`, DS:399-413). From a live signed question to the worker's
  held door, with **no `instance` field**: the jobs the worker holds in arrival order, and whether the
  worker is reachable or refused the question (DS:363-386). With two small changes to the worker it
  could also show each job's lane and state and the hold's end time, both of which already exist in
  memory (`service/worker.ts:2531-2540,2565-2574`); with a third (a worker-to-dispatcher "ended"
  ping on the token door, beside `/started`, `service/serve.ts:168`) a short list of recent
  finishes.
- **Where it lives.** A third listener in the dispatcher process, default `127.0.0.1`, published to
  the tailnet only with `tailscale serve`. Serve is "available within your tailnet", with ACLs
  applying, and adds `Tailscale-User-Login` and related headers for tailnet users; it strips any
  such headers a client sends and recommends the backend listen on localhost
  (https://tailscale.com/kb/1312/serve). Funnel is the public one, and a port is either Serve or
  Funnel, never both (https://tailscale.com/kb/1223/funnel). This deployment already has Funnel on
  10000 and a Serve on 8443 (DS:954-955). Funnel can use only 443, 8443 and 10000 (Funnel page).
  Which HTTPS ports Serve accepts is **UNVERIFIED**: the CLI page I read lists none, only 443 in
  examples (https://tailscale.com/kb/1242/tailscale-serve). Serve supports `--bg` and `--https=<port>`
  (same page) and proxies only to `http://127.0.0.1` targets.
- **Cost in this repo.**
  - `service/settings.ts`: two optional settings (host, port). The settings table in DS:261-276 must
    equal it; `tests/service/settings.test.ts` holds that (DS:259).
  - `service/serve.ts`: `door()` answers `POST` routes and `GET /health` only (`service/serve.ts:56-65`),
    so the status listener needs its own small `GET` handler, about 30 lines.
  - `service/dispatcher.ts`: a `status()` reader over `jobs` and the asks, about 40 lines. A signed
    held question already exists (`askHeld`, `service/serve.ts:133-137`).
  - `service/worker.ts`, `service/job.ts`: extend the held answer with `state` and the hold, about 35
    lines. The two processes must run the same release (DS:454-456), so no compatibility shim.
  - Tests in `tests/service/`; a section in DS; a `tailscale serve` command in the deploy README.
  - The container must be recreated, since Docker reads `--env-file` at creation (DS:947-948).
    `deploy/unraid/dispatcher-container.sh` already does this on upgrade (`:44-60,64-75`).
  - Size: roughly 250-400 lines with tests for JSON; a plain HTML view adds about 100.
- **What it exposes.**
  - Repository names, item numbers and job kinds, to anyone the tailnet's ACLs allow. For private
    repositories that is private metadata. No title, no body, no secret needs to be on the page.
  - **It must not be added to the webhook door.** Funnel publishes that whole listener
    (DS:954-959), and `GET /health` is already public there (`service/serve.ts:62`).
  - **The held door hazard.** A question that names a dispatcher `instance` makes the worker drop every
    queued job from another instance (`service/worker.ts:2474`). The status reader must never send
    `instance`; only a question without it "only reads" (DS:376-378, `service/job.ts:448-454`).
  - `WORKER_SECRET` stays server-side: the page asks the worker itself and returns the answer.
  - No App permission is needed; all of it is already held.
- **When the dispatcher is down.** The page is gone. The worker's held door is alive but only a
  holder of `WORKER_SECRET` can ask it. GitHub's labels remain.
- **When the worker is down.** The page stays up and can say "worker unreachable". It must not
  present the dispatcher's own `jobs` map as current then: with the worker unreachable the scan is
  skipped (DS:373), so the map is not pruned and would show phantom running jobs. Show "as of" and
  the reachability flag together.
- **Fit.** The best match to "what is running and what is queued" for one owner. It does not by itself
  tell you the dispatcher died, because it dies too.

### Option 2. Prometheus and Grafana; Unraid's own dashboard

- **What it shows.** Time series over the same data: held jobs by kind and lane, the agent lane's
  hold, deliveries by outcome, token requests by status, scan counts, worker reachability. Prometheus
  adds an `up` series per scrape target, `1` if reachable and `0` if the scrape failed
  (https://prometheus.io/docs/concepts/jobs_instances/), so a dead dispatcher raises its own alarm
  with history intact.
- **Format.** The Prometheus text format is plain text over HTTP with `# HELP` and `# TYPE` lines
  (https://prometheus.io/docs/instrumenting/exposition_formats/). Hand-written output needs no
  dependency; the package's dependencies today are Sandcastle and typing packages
  (`package.json:28-34`), and adding one is a decision for `docs/agents/releasing.md` (which I did
  not read).
- **Alerting.** Alertmanager receivers include `email_configs`, `pushover_configs`, `slack_configs`,
  `telegram_configs` and `webhook_configs` (https://prometheus.io/docs/alerting/latest/configuration/).
  Grafana contact points include Email, Slack, Telegram, Pushover and Webhook; ntfy is not named on the
  page I read (https://grafana.com/docs/grafana/latest/alerting/fundamentals/notifications/contact-points/).
- **Where it lives.** `/metrics` on option 1's listener; Prometheus and Grafana as containers on
  Unraid. Whether they are available from Unraid's Community Apps is **UNVERIFIED**. A worker-side
  `/metrics` would be a new unsigned `GET` on a door that is meant to be "reachable from the
  dispatcher, and from nothing else" (DS:460), so prefer metrics derived by the dispatcher.
- **Unraid's own dashboard.** Unraid's Docker view shows a container health indicator: green running
  and responding, yellow failing its health check, white no health check
  (https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/).
  The dispatcher container is created with no health check (`deploy/unraid/dispatcher-container.sh:71-73`),
  and both doors already answer `GET /health` (`service/serve.ts:62`, DS:278). Docker's `docker run`
  takes `--health-cmd`, `--health-interval`, `--health-retries`, `--health-timeout`
  (https://docs.docker.com/reference/cli/docker/container/run/). Adding them is a few lines in
  `dispatcher-container.sh` plus a drift entry (`:44-60`), and turns the dashboard yellow when the
  dispatcher stops answering. It says "the process answers", not "the worker works". The Unraid
  labels `net.unraid.docker.webui` / `.icon`, which would put a link to a status page on the Docker
  tab, are documented only in forum threads I could find: **UNVERIFIED** from a primary source.
- **Cost.** In the repo, about 150-250 lines with tests (counters in memory, reset at restart, which
  Prometheus handles); a Grafana dashboard JSON would add a file. The operator's cost, running two more
  containers, is the larger part.
- **Exposure.** As option 1. Keep repository names out of metric labels, or accept them in
  Prometheus's store.
- **When down.** Dispatcher down: `up == 0` fires and history stays. The whole Unraid host down: the
  monitoring is down too, so a heartbeat from elsewhere (option 4) is still needed.
- **Fit.** Right if the owner already runs this stack. For one person asking "what is running now",
  it is more machinery than the question needs.

### Option 3. GitHub-native surfaces

**3a. A check run or commit status per job.**

- **Check runs.** Only GitHub Apps can create them; statuses are `queued`, `in_progress` and
  `completed`, and `completed` needs a conclusion; `name` and `head_sha` are required; at most 1,000
  runs with one name per check suite
  (https://docs.github.com/en/rest/checks/runs). Creating one needs Checks: write
  (https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). The App has
  Checks: **read** today (DS:133). GitHub creates a check suite for an App's first check run
  (https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks).
- **Statuses.** States are `error`, `failure`, `pending`, `success`, at most 1,000 per SHA and
  context (https://docs.github.com/en/rest/commits/statuses). The App already has Commit statuses:
  write (DS:134). The API accepts `pending` (`engine/writer.ts:71`); the loop avoids posting one
  because "a `pending` one would read as a check that never finished" (`shared/record.ts:252-253`),
  which is the exact risk here: a worker that dies leaves it pending.
- **The loop reads checks and statuses as CI.** `review:collect-checks` and `merge:gate` decide what
  is CI with `AGENT_CHECKS` and `isLoopStatus` (`shared/loop-checks.ts:47,59`). A new status
  context not added to `isLoopStatus` would be read as CI, and the dispatcher turns a final-state
  status from a non-loop context into a merge job for an armed PR
  (`service/dispatcher.ts:368,884-903`). A completed check suite from the App itself would likewise
  start a merge job (`service/dispatcher.ts:880-882`). Both are cheap (merge jobs are coalesced,
  DS:635-645) but they are noise, and a check run left `in_progress` would be waited on by the CI wait
  unless its name matches `AGENT_CHECKS`.
- **A commit is required.** An implement job on an issue has no head until it opens a PR
  (CTX:739-740), so this surface cannot show the longest jobs at their start.
- **Cost.** `service/worker.ts` (post at job start and end), a command or a dispatcher call to carry
  the write (the loop's writes are commands named `<workflow>:<step>`, CTX:583-590; ADR 0005 says
  writes are calls with a log, title only read), `shared/loop-checks.ts`, the permission row in DS:126-135
  if check runs are used, tests. About 200-400 lines.
- **Where GitHub shows it.** On the PR's checks list; the pages I fetched do not describe the
  display, so that is **UNVERIFIED**. Whether a changed App permission needs each installation's
  owner to accept it again is also **UNVERIFIED** (not fetched).
- **When down.** GitHub keeps it, stuck. A reconciler would need the scan to close stale ones.
- **Fit.** Weak. It is the most "GitHub-native" and the most entangled with the merge gate.

**3b. A pinned status issue.**

- **What and how.** One issue per repository (or one in a private "home" repository) whose body the
  dispatcher rewrites: a table of active and recent jobs and a "last updated" line. Edit needs
  Issues: write, which the App holds (DS:132); GitHub's update-an-issue page names no App
  permission, so that is **UNVERIFIED** against the page. Three issues may be pinned per repository
  (https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository).
  The owner can pin it by hand once. A `pinIssue` mutation exists in GraphQL
  (https://docs.github.com/en/graphql/reference/issues#mutation-pinissue, seen through a search
  result); whether an installation token may call it is **UNVERIFIED**.
- **Cost.** A body writer on the dispatcher's GitHub edge (it already posts comments with a token
  minted for the purpose, `service/dispatcher.ts:147`, DS:408), a variable naming the issue, a
  refresh on each dispatch and each scan, and ignoring its own `issues` `edited` deliveries. About
  150-250 lines. It would still not know when a job ends (section 2).
- **Exposure.** Repository names and item numbers in the issue body: in a public repository, public.
  Put it in a private one.
- **When down.** It goes stale and says nothing unless it carries a time and the reader checks it.
- **Fit.** Fair. It is the one GitHub-native view the owner can open on a phone without a tailnet.

**3c. A Projects board.** GraphQL only; an installation token may be used for Projects (v2)
(https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects).
The App-permissions page lists only organization-level Projects endpoints
(https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), and I found no
primary statement that an installation can reach a user-owned project: **UNVERIFIED**, and it
matters if `jeffwlawson` is a user account. A board shows items by column, not runs, and needs a new
permission. Not recommended.

**3d. Deployments and deployment statuses.** A deployment needs a `ref`, creating one needs
Deployments: write, and `required_contexts` by default demands every status context on the commit be
`success`, answering `409` otherwise, so the loop would have to pass an empty list
(https://docs.github.com/en/rest/deployments/deployments). A `success` status marks earlier
deployments of the same environment `inactive`. States include `queued` and `in_progress`
(https://docs.github.com/en/rest/deployments/statuses). It is a model of "something deployed", not of
"a job ran", and needs a new permission. Not recommended.

### Option 4. Push alerts and an off-box heartbeat

- **What it shows.** Not a picture; an interruption when something needs the owner or has stopped.
  The dispatcher can see these without new signals:
  - the worker cannot be reached (a post fails, or the scan is skipped, DS:373);
  - a job reached its deadline before its next token request (`service/dispatcher.ts:1001-1004`);
  - an item reached the scan limit and was left for a person (DS:406);
  - `agent:blocked` going on an item. Deliveries for those events already arrive (the App
    subscribes to Issues and Pull request, DS:177-181) and are logged with a reason (DS:236); that
    the code sees an `unlabeled` or `labeled` delivery for a non-trigger label I did not verify.
  - The worker alone knows the usage-limit hold (`service/serve.ts:241-243,253-258`) and a job's end
    (`service/serve.ts:246`). To alert on them the worker must tell the dispatcher: a new signed
    `POST /event` on the token door, next to `/started` (`service/serve.ts:168`), which is the one
    door the worker's firewall allows (DS:897-905). About 80 lines plus tests.
- **Channels, from primary sources.**

| Channel | What it needs | Notes |
|---|---|---|
| ntfy | `POST` to a topic URL; optional `Title`, `Priority`, `Tags`, `Click` headers; a Bearer access token for protected topics. Self-hostable | "The topic is essentially a password" on the public server (https://docs.ntfy.sh/publish/). Rate limits for publishing: **UNVERIFIED** (page truncated) |
| Pushover | An application token and a user key; `POST https://api.pushover.net/1/messages.json`; 1,024-character messages; priority `2` repeats until acknowledged, with `retry` at least 30 s and `expire` at most 10,800 s | 10,000 messages a month per account, shared by its applications (https://pushover.net/api). One-off app price: not on that page |
| Telegram | A bot token and a `chat_id`; `https://api.telegram.org/bot<token>/sendMessage`; `text` 1-4096 characters | (https://core.telegram.org/bots/api). How to obtain the token is only linked from the page |
| Slack | An incoming webhook URL from a Slack app, tied to one channel; `POST` JSON with `text` | The URL is a secret; Slack revokes leaked ones (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/). Rate limit: not stated on that page |
| Unraid's own agents | Configured in the Unraid UI under Notification Settings: ntfy.sh, Pushover, Slack, Telegram, Discord and others | (https://docs.unraid.net/unraid-os/getting-started/set-up-unraid/customize-unraid-settings/). They send Unraid's own events. A way for a container running as uid 99 (DS:927-933) to trigger one is **UNVERIFIED**; post to the service directly instead |
| Email | An SMTP relay and credentials | The package has no mail client; Node has none built in. I verified no primary source for Unraid's SMTP settings. Not recommended here |

  Existing GitHub notifications may already cover "blocked": the App's `stopped:` comments are
  ordinary comments on items. Whether they reach the owner's phone depends on watch settings, which I
  did not verify (open question 4).
- **The heartbeat.** An alert sent by the dispatcher cannot announce the dispatcher's death. A dead
  man's switch inverts it: the dispatcher pings a URL on a timer and a service elsewhere alarms when
  the pings stop. Healthchecks.io works that way: a check has a ping URL, goes Late then Down when
  pings stop, and sends alerts through integrations (https://healthchecks.io/docs/); it is also
  self-hostable, but a copy on the same Unraid host would die with it. Uptime Kuma has a "Push"
  monitor type and 90+ notification services, self-hosted by Docker
  (https://github.com/louislam/uptime-kuma), with the same placement caveat. A ping carries no data.
  The worker can be covered by the dispatcher: it knows when the worker is unreachable.
- **Cost.** A small `service/notify.ts` (a `fetch` with a timeout; never logs the URL), two or three
  optional settings, calls from the dispatcher at the events above, a heartbeat timer. About 150-250
  lines with tests; the worker-to-dispatcher event adds about 80. URLs and tokens go in
  `service.env`, which only root can read (DS:911).
- **What it exposes.** Payloads leave the house to a third party: send `repo#N kind state` and never
  a title, body or comment. A public ntfy topic is readable and writable by anyone who learns its
  name. No App permission. The dispatcher already has unrestricted egress (it reaches GitHub); the
  worker does not (DS:855-856).
- **When down.** The heartbeat alarm is the only view that works with the dispatcher or the host
  dead; that is its job. Alerts from a live dispatcher about a dead worker work.
- **Fit.** The best answer to "what is not running"; says nothing of what is.

### Option 5. Structured logs and a log viewer

- **Today.** Both processes write free text prefixed with an ISO timestamp (`service/serve.ts:89`).
  The dispatcher's goes to the container's log; the worker's to the agent box's journal; the check
  scripts already grep both (`deploy/unraid/check-unraid.sh:175,251`,
  `deploy/unraid/check-box.sh:144,220`). Unraid's Docker view has a Logs action, and `docker logs` is
  documented there (managing-and-customizing-containers page above). Docker's default driver is
  `json-file` and "by default, no log-rotation is performed"
  (https://docs.docker.com/engine/logging/configure/).
- **Dozzle.** A real-time viewer for Docker containers, with no database; it runs from one
  `docker run` that mounts `/var/run/docker.sock`; it signs in with GitHub or OIDC; it can alert on
  log patterns to Slack, Discord, ntfy or a webhook (https://dozzle.dev/). Mounting the docker socket
  gives the viewer control of the host's containers (my inference, not from that page). It sees the
  dispatcher; it does not see the worker, which is a systemd unit in a VM.
- **Loki.** Indexes labels only, not log contents; an agent such as Grafana Alloy ships logs;
  Grafana queries with LogQL
  (https://grafana.com/docs/loki/latest/get-started/overview/). Whether Alloy reads the VM's journal
  is **UNVERIFIED**. This is a stack, not a view.
- **Structured logs.** Moving the service to JSON or `key=value` lines touches every `log(...)` call in
  `service/serve.ts` and `service/dispatcher.ts` (I did not count them), the check scripts that grep
  messages, and the tests that assert them. Large for a gain that options 1 to 4 deliver more
  directly. Not recommended.
- **When down.** Logs persist on disk after a process dies; reading them needs the host.
- **Fit.** Good for "why did it stop", poor for "what is running".

### Option 6. A terminal command over the held door

- **What and where.** `deploy/unraid/status.sh`, run on Unraid as root. It would:
  1. report the container's state (the way `check-unraid.sh` does);
  2. ask the worker's held door and print the held jobs in arrival order;
  3. read `STATE_DIR/dispatcher.json` (mode 700 and owned by uid 99, so root, `deploy/unraid/dispatcher-container.sh:37-38`) for jobs and items at the scan limit;
  4. say plainly when a part cannot be reached.
- **Precedent.** `deploy/unraid/upgrade.sh:256-310` already asks the held door from inside the
  dispatcher's container, where `WORKER_URL` and `WORKER_SECRET` are set, without printing the secret
  or naming an `instance`, so it only reads (DS:989-991). To work with the dispatcher stopped, the
  script can run the same snippet in a throwaway container with the same `--env-file`, the pattern
  install uses for the package (DS:909-911); that is my design, not something the repo does today.
- **What it can show without a service change.** Held jobs in arrival order, each with its kind and
  item. Which one is running is an inference from order and kind (agent kinds share one lane, light
  kinds another, DS:476-490, with a per-item chain on top, DS:496-501), so exact state needs the held
  answer extended (option 1). `watch -n 5 bash status.sh` is a live view with no code.
  Finished runs stay with `runs.sh` on the box.
- **Cost.** About 80-150 lines of bash plus a test beside the other deploy tests (I did not read
  `tests/deploy/`; `docs/installability.md:664` mentions it). It would sit under the planned
  `agent-service.sh` front door as another verb (`docs/installability.md:592`). A Node `status`
  subcommand is a different matter: the repo's convention is that runners and commands take no
  arguments and only `init` and `doctor` are typed by a human (`CLAUDE.md`, Conventions), so a new
  human-typed command is an owner decision (open question 7). A TUI framework adds a dependency for
  a screen `watch` already draws. Not recommended.
- **Exposure.** None new: local, root, read-only.
- **When down.** Dispatcher stopped: as above, it still works. Worker down: it prints that. Unraid
  down: there is no shell to run it in.
- **Fit.** Good for the owner at the server, awkward from a phone.

### Option 7. How comparable self-hosted runners expose queue and run state

| System | Run and queue state | Machine-readable | Source |
|---|---|---|---|
| GitHub Actions self-hosted runner | Settings, Actions, Runners lists each runner as Idle, Active or Offline; runner logs in `_diag`; `journalctl -u <service>` for the service | `GET .../actions/runners` returns `status` and `busy`; needs repository or organization admin | https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/monitoring-and-troubleshooting-self-hosted-runners, https://docs.github.com/en/rest/actions/self-hosted-runners |
| Buildkite agent | Optional HTTP health service from `--health-check-addr`: `/`, `/status` (human page), `/agent/<n>` (heartbeat age), `/metrics` (Prometheus, agent 3.113.0 and later). The docs advise against exposing it to the internet | Queue depth is not in `/metrics`; the separate `buildkite-agent-metrics` tool reads the Agent API and publishes per queue `ScheduledJobsCount`, `RunningJobsCount`, `WaitingJobsCount`, idle and busy agents, to Prometheus, StatsD, CloudWatch and others, using an agent registration token | https://buildkite.com/docs/agent/self-hosted/monitoring-and-observability, https://github.com/buildkite/buildkite-agent-metrics |
| Woodpecker | Web UI; server `/metrics` is enabled only when `WOODPECKER_PROMETHEUS_AUTH_TOKEN` is set, and takes it as a bearer token; an optional separate listener `WOODPECKER_METRICS_SERVER_ADDR` | `woodpecker_pending_steps`, `woodpecker_waiting_steps`, `woodpecker_running_steps`, `woodpecker_worker_count` | https://woodpecker-ci.org/docs/administration/configuration/server |
| Drone | `/metrics` "restricted and requires an authorization token" | `drone_pending_builds`, `drone_running_builds`, `drone_pending_jobs`, `drone_running_jobs` | https://docs.drone.io/server/metrics/ |
| Gitea Actions (`act_runner`) | Actions from Gitea 1.19; `/metrics` off by default (`[metrics] ENABLED=false`) with an optional token (https://docs.gitea.com/administration/config-cheat-sheet). The runner status page in the UI: **UNVERIFIED**, the runner pages I read do not describe it (https://docs.gitea.com/usage/actions/overview, https://docs.gitea.com/usage/actions/act-runner). Whether Gitea's metrics include runner queue gauges: **UNVERIFIED** | | |

What to take from these:

- Every one offers a **list of runs and agents in a web UI** and a **token-protected Prometheus
  endpoint with pending, running and (Buildkite) waiting counts**. Those three names are the common
  vocabulary and would be the right gauge names here.
- Two of them keep the metrics listener **separate** or off by default (Woodpecker, Gitea), and
  Buildkite says not to expose its service to the internet. That is the same call as keeping a status
  listener off the Funnel (option 1).
- **None of these runners holds its own queue.** Their servers do, and their agents are polled or
  report in. Here the queue is in the worker's memory (DS:799), and the party that polls it is the
  dispatcher, so the dispatcher is the right place to assemble a view.
- I found no built-in push notifications in the pages read; none was documented there.

### Option 8. Agent-loop and agent-orchestration projects

- **Sandcastle** (the library this loop runs on, `docs/landscape.md:498-520`). It is per run, not per
  queue. By default progress goes to a log file under `.sandcastle/logs/` and `result.logFilePath`
  names it; `logging: { type: "stdout" }` shows spinners and status in the terminal; an
  `onAgentStreamEvent` callback receives each text chunk, tool call and stdout line, in file mode
  only (https://raw.githubusercontent.com/mattpocock/sandcastle/main/docs/guide/run-logs.md). Its
  hooks fire at worktree and sandbox setup, with none documented for the end of a run or an
  iteration (https://raw.githubusercontent.com/mattpocock/sandcastle/main/docs/guide/hooks.md). It has
  no queue and no dashboard in the pages I read. Whether this repo's runners set `logging` or use
  `onAgentStreamEvent` I did not check: **UNVERIFIED**.
- **The agent's own telemetry.** Claude Code can export OpenTelemetry metrics (sessions, cost, token
  usage, lines of code, active time) and events (`api_request`, `api_error`, `tool_result`) with
  `CLAUDE_CODE_ENABLE_TELEMETRY` and the OTLP, Prometheus or console exporters; prompt text is
  redacted unless `OTEL_LOG_USER_PROMPTS=1`
  (https://code.claude.com/docs/en/monitoring-usage). It would show cost and token use per
  session. The worker hands each subcommand an environment "built from its declaration in the
  contract" and nothing else (DS:542-546), and the agent's sandbox has only its own loopback
  (DS:41-45), so it would take a contract change and a route out, for numbers no question here asks.
  Not recommended now.
- **Others** (from `docs/landscape.md`, read by that document's author on 2026-10-07, not re-fetched
  today): OpenHands presents a "self-hosted developer control center" (`:284-285`) and its software
  factory polls labels and runs a watchdog (`:310-313`); Open SWE lists a dashboard, Slack and
  Linear as triggers (`:391`). AIF Handoff's README advertises a Kanban board with real-time
  WebSocket updates and says it surfaces a human handoff; no notifications are mentioned
  (https://raw.githubusercontent.com/lee-to/aif-handoff/main/README.md).
- **The pattern.** Projects with their own database ship their own board. This loop's design is that
  GitHub is the board (labels, comments, statuses), which fits what section 2 found: the only part
  GitHub cannot hold is the live service state. That points to a small read-only view of that state
  (option 1, 6), not a product-sized UI. This is inference.

---

## 5. Cross-cutting

### What stays visible when a part is down

| Down | GitHub (labels, comments, statuses) | Option 1/2 view | Option 4 alerts | Option 4 heartbeat | Option 6 script |
|---|---|---|---|---|---|
| Worker only | Stale; labels stay on | Up, says "worker unreachable" | The dispatcher sends one | Still pings | Says so |
| Dispatcher only | Stale | Gone | Gone with it | **Stops: alarm fires** | Works if built to run without the container |
| Unraid host (both) | Stale | Gone | Gone | **Stops: alarm fires** (the checker must be off the host) | No shell |
| Funnel or Tailscale | GitHub sees failed deliveries (inference) | Reachable only if the tailnet is up | Unaffected | Unaffected | Unaffected |
| GitHub | Gone | Unaffected | Unaffected | Unaffected | Unaffected |

A view that dies with what it reports is a real defect, so the table's rule is: **a status view
tells you what is happening while the service is up; only a check outside it tells you the service is
not.** No option is both.

### Security checklist for any of these

- Do not add routes to the webhook door; Funnel publishes everything on it (DS:954-959).
- Never send an `instance` in a held question from a status reader; it drops queued jobs
  (`service/worker.ts:2474`).
- Keep `WORKER_SECRET`, the App key and notification URLs server-side and out of pages and logs;
  `service.env` is root-only (DS:911). The state file holds no secret (DS:314).
- Repository names, item numbers and kinds are the whole of the new data; leave out titles, bodies and
  comment text.
- A new App permission (Checks write, Deployments, Projects) changes the contract in DS:124-135 and the
  dispatcher's gap warning (DS:153-158; I did not read `appGaps`), and every installation carries it.
  Statuses and Issues need none.
- Any new setting needs the DS settings table and `tests/service/settings.test.ts` to agree (DS:259).
- Docker recreates, not restarts, on an `--env-file` change (DS:947-948), so a new setting is an
  upgrade-time container recreate.

---

## 6. Ranked shortlist for this setup

1. **Option 6, `status.sh`.** Smallest; no service change; shows running and queued on demand;
   tells you what you actually want to see before anything larger is built.
2. **Option 4, heartbeat plus a few alerts** (worker unreachable, job past its deadline, item left for
   a person, `agent:blocked`). The only option that covers "not running", including a dead
   dispatcher. Add the Unraid container health check (option 2's three-line part) beside it.
3. **Option 1, a tailnet status endpoint**, with the held answer extended by lane, state and hold.
   Worth building once `status.sh` shows you want the same view on a phone or laptop.
4. **Option 0, a saved search and Recent Deliveries.** Free at any time; put in the owner's bookmarks
   now.
5. **Option 3b, a pinned status issue.** Phone friendly; stale when it matters.
6. **Option 2, Prometheus and Grafana.** Only if already run.
7. **Option 5, Dozzle** as a debugging aid; not Loki; not structured logs.
8. **Option 3a, check run or status per job.** Entangled with the merge gate; not now.
9. Not recommended: Projects, Deployments, a TUI framework, Claude Code telemetry for visibility,
   email.

## 7. Recommended first small step

Write `deploy/unraid/status.sh`: read-only, root, no arguments except an optional count, in the style
of `runs.sh` and `check-unraid.sh`. It prints (a) the dispatcher container's state, (b) whether the
worker answers and the jobs it holds in order, using the `upgrade.sh:256-310` pattern with no
`instance`, (c) the jobs and at-limit items in the state file, and (d) a clear line for each part it
cannot reach. About 100 lines and a deploy test. Reason: it needs nothing from the running
service, adds no exposure, and its first week of use answers open questions 1 and 4, which decide
whether options 1 and 4 are worth their size. If the owner wants one more step at the same cost,
add `--health-cmd` to `dispatcher-container.sh:71-73` so Unraid's own Docker view turns yellow when the
dispatcher stops answering.

## 8. What I could not verify

- Nothing was run against a real machine. I did not run the scripts, touch Unraid or the agent box,
  or call any API with a token. All behaviour is from docs and code on `origin/main`.
- Which HTTPS ports `tailscale serve` accepts, and whether the port I would pick is free on this
  server. Only the docs for Funnel's ports (443, 8443, 10000) and this deployment's use of 10000 and
  8443 (DS:954-955) are known.
- Unraid specifics: the `net.unraid.docker.*` labels (forum threads only), whether Prometheus and
  Grafana are in Community Apps, any way to call Unraid's notification agents from a container, and
  Unraid's SMTP settings.
- GitHub specifics: where a check run or status appears on a PR; whether changing an App's permissions
  forces each installation to re-approve; whether an installation token can call `pinIssue`; whether
  an installation token can reach a user-owned Projects v2 board; the GitHub search syntax for OR-ing
  labels; the `workflow_job` webhook (the page I fetched was cut before it); whether the App's
  `stopped:` comments already reach the owner's phone.
- Vendor limits not shown on the pages read: ntfy.sh's publishing rate limits, Slack's webhook rate
  limit, Pushover's one-off app price.
- Gitea's runner status UI and whether its `/metrics` has queue gauges.
- Whether this repo's runners use Sandcastle's `logging` or `onAgentStreamEvent`.
- Whether the dispatcher's delivery code handles, or merely logs, `unlabeled` and non-trigger
  `labeled` events (relevant to alerting on `agent:blocked`).
- Not read: `docs/agents/releasing.md`, `docs/agents/changing-a-runner-or-a-command.md`, ADR 0005,
  `tests/deploy/`, `appGaps`, `setup/doctor.ts`. Each may add steps to a change above.
- `docs/self-hosted-runners.md` and `docs/parity.md` were read for conventions and searched for
  visibility material; they hold none that bears on this question.

## 9. Open questions only the owner can answer

1. **Where will you look?** On Unraid's shell, on a laptop or phone on the tailnet, or on a phone off
   it? The first is option 6, the second option 1, the third needs a push (option 4) or GitHub
   (option 3b).
2. **Do you already run Prometheus, Grafana, Uptime Kuma, Healthchecks or ntfy**, on Unraid or
   elsewhere? That decides whether option 2 is cheap or a new project, and where a heartbeat checker
   can live that is not the Unraid host.
3. **Is `jeffwlawson` a user or an organization account, and are the served repositories private?**
   It decides whether Projects v2 is possible at all and whether a status issue can safely name
   repositories.
4. **Which events should interrupt you:** blocked, stalled past deadline, worker down, usage-limit wait
   began or ended, every finish? And do the App's `stopped:` comments already reach your phone as
   GitHub notifications?
5. **Which third party may see repository names and item numbers**, if any? Self-hosted ntfy keeps them
   home; Pushover, Telegram and Slack do not.
6. **Is a new App permission acceptable** (Checks write for option 3a)? If not, 3a is statuses only.
7. **Should a human-typed `status` command live in the package** (like `init` and `doctor`) **or stay a
   `deploy/` script** (like `runs.sh`), given the "commands take no arguments" convention?
8. **How much history do you want for "just finished":** the last few jobs, the last day, or all of it?
   `WORK_DIR/runs` is never pruned (DS:667-668) and the dispatcher keeps nothing about ended jobs, so a
   longer history needs a decision about where it is stored.
