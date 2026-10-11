# Deploying the service orchestrator

The loop has two orchestrators. The **Actions orchestrator** is the callers and reusables
[ADOPTING.md](./ADOPTING.md) installs. The **service orchestrator** is two processes you run on a
machine of your own, so the agent spends none of your Actions minutes:

- the **dispatcher**, which holds the GitHub App's key, receives GitHub's webhooks, decides which
  delivery is a job, and mints a short-lived token, scoped to one repository, each time the worker
  asks for one;
- the **worker**, which receives jobs from the dispatcher and runs review the way `review.yml`
  does, with the runner in a sandbox.

Each is a subcommand of the published package, so deploying the service is configuration rather
than a build. A
repository opts in with the repository variable `AGENT_ORCHESTRATOR=service`
([ADOPTING §2e](./ADOPTING.md#2e-choosing-the-orchestrator)); the service refuses every other
repository, and answers `agent:review` only.

This guide grows with the service. It covers the dispatcher so far: the worker is not in the
package yet.

## The GitHub App

The service acts as a GitHub App you own, which may be the loop's own App (ADOPTING §2) or one of
its own. Its login, `<slug>[bot]`, is what the service's reviews are posted as, and the dispatcher
reads it off the App's own record rather than from a setting, so a typo cannot make every round
the first.

### Permissions

Repository permissions:

| Permission | Access | Why |
|---|---|---|
| Metadata | read | every API call, and a label's sender's permission |
| Variables | read | `AGENT_ORCHESTRATOR`, re-read at every token, and the variables review reads |
| Contents | read | the checkout, and the pull request's history |
| Pull requests | write | the review, its threads, the title and summary, and the ready mark |
| Issues | write | comments and labels, and a PRD's parent |
| Checks | read | CI's result, which the review's verdict reads |
| Commit statuses | write | the verdict and the fix-round statuses |

A permission the App lacks fails the mint of the token that asks for it, so it is named in the
dispatcher's log as the job's phase starts, rather than surfacing as a failed write mid-run.

Install the App on each repository the service is to serve. Installing it on all your
repositories enrols none of them: the dispatcher acts only where `AGENT_ORCHESTRATOR` is `service`.

### The webhook

In the App's settings, under *Webhook*:

- **Active**, with the **Webhook URL** the address your dispatcher's webhook door is reached at
  from the internet, ending `/github`;
- a **Webhook secret**, which is the dispatcher's `GITHUB_WEBHOOK_SECRET`;
- under *Subscribe to events*, **Pull request**.

GitHub's *Recent Deliveries* page shows each delivery and the dispatcher's answer: `202` for every
delivery whose signature verified, whatever became of it, and `401` for one that did not. What
became of it is in the dispatcher's log.

## The dispatcher

The one process that holds the App's key. It needs:

- Node 24 or later, and the package (`npm exec @jeffwlawson/agent-workflows@<version> dispatcher`,
  or an install of it);
- the App's private key in a file it can read;
- its **webhook door** reachable from the internet, through whatever you use to publish a port
  (a reverse proxy, a tunnel);
- its **token door** reachable from the worker, and from nothing else. The two are separate
  listeners so the one you publish mints nothing;
- the worker's job door reachable from it.

It answers each delivery at once and does its work afterwards, and a delivery becomes a job only
when all of these hold:

- it is a pull request labelled with a label the service answers (`SERVICE_LABELS` in
  `shared/record.ts`: `agent:review`);
- the App is installed on the repository;
- the repository's `AGENT_ORCHESTRATOR` is `service`;
- the head is in the same repository, not a fork;
- the pull request is open;
- the label's sender can write to the repository.

Every other delivery is logged with its reason. A job carries what the label's event carried, the
repository variables review reads, the App's login, a job id, a deadline and the package's version.
It carries no token: the worker asks for one per phase, `read` or `write`, and the dispatcher mints
one only for a job it dispatched, before that job's deadline, for that job's repository alone, and
after reading `AGENT_ORCHESTRATOR` again. Deleting the variable stops a job in flight at its next
phase.

### Settings

Read from the environment. A missing required one stops the dispatcher at start, naming each.
`tests/service/settings.test.ts` holds this table equal to `DISPATCHER` in `service/settings.ts`.

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `GITHUB_APP_ID` | required | | the App's ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | required | | a path to the App's private key, in PEM |
| `GITHUB_WEBHOOK_SECRET` | required | | the App's webhook secret |
| `WORKER_URL` | required | | the worker's job door, where a job is posted |
| `WORKER_SECRET` | required | | the secret the dispatcher and the worker share, which signs a job and a token request |
| `WEBHOOK_HOST` | optional | `127.0.0.1` | the address the webhook door listens on |
| `WEBHOOK_PORT` | optional | `8790` | the webhook door's port; GitHub's deliveries arrive at `POST /github` |
| `TOKEN_HOST` | optional | `127.0.0.1` | the address the token door listens on: one the worker reaches |
| `TOKEN_PORT` | optional | `8791` | the token door's port; the worker asks at `POST /token` |
| `JOB_DEADLINE_MARGIN_MINUTES` | optional | `60` | added to review's time limit (its CI wait and `AGENT_REVIEW_TIMEOUT_MINUTES`) for a job's deadline, covering the phases around the runner's and the time a job waits in the worker's queue |

Each door also answers `GET /health` with `200`.

### What it does not keep

- **A delivery that arrives while the dispatcher is down is lost.** GitHub does not redeliver on
  its own; redeliver it from the App's *Recent Deliveries*, or remove the label and add it again.
- **The jobs it dispatched are held in memory.** A dispatcher restarted mid-job refuses that job's
  next token request as unknown, and the job ends there. Remove the label and add it again.
