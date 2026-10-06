# Prototype: an `agent:review` orchestrator outside Actions (#364)

**Throwaway.** This branch is never merged. It exists to find out what a second orchestrator needs
from the runners, from GitHub and from Sandcastle. The deliverable is the findings on #364, not
this code.

```text
GitHub webhook ──► POST /github ─┐   (verify signature, pull_request.labeled → Job)
any caller     ──► POST /jobs   ─┤   (verify signature, Job JSON)
                                 ▼
                      core: runReview(job)
                        pre-flight · clone at head · base as local branch
                        CI snapshot · fresh OUTPUT_DIR · allowlisted env
                        node dist/cli.js review   (sandbox: AGENT_SANDBOX)
                        post review_payload.json back to the PR
```

Only `github.ts` knows a payload is GitHub's. A Job is `{ kind: "review", repo, pr, headSha? }`.

## Run it

```bash
npm ci && npm run build                   # the runners, from this branch
mkdir -p ~/.config/agent-orchestrator
claude setup-token                        # prints a long-lived token; put it in the file below
$EDITOR ~/.config/agent-orchestrator/secrets.env
#   WEBHOOK_SECRET=<anything random, e.g. openssl rand -hex 24>
#   CLAUDE_CODE_OAUTH_TOKEN=<from claude setup-token>
chmod 600 ~/.config/agent-orchestrator/secrets.env
node prototype/orchestrator/server.ts     # 127.0.0.1:8787
```

Then, in another terminal:

```bash
node prototype/orchestrator/replay.ts owner/name <pr>             # as GitHub would deliver it
node prototype/orchestrator/replay.ts owner/name <pr> --generic   # as any other caller would
```

For live delivery, use `gh webhook forward --repo owner/name --events pull_request --url
http://127.0.0.1:8787/github --secret <WEBHOOK_SECRET>` (the `cli/gh-webhook` extension), then add
the label.

| Setting | Default | |
|---|---|---|
| `ORCH_LABEL` | `proto:review` | Not `agent:review`: that one also starts the Actions loop, and the PR would be reviewed twice |
| `ORCH_SANDBOX` | `none` | **`bwrap`** runs each agent pass in bubblewrap through an *isolated* Sandcastle provider (`shared/bwrap.ts`): a private per-job home and `/tmp`, read-only `/usr` and toolchain, no view of the host's home, and a guarded `copyFileOut`. Tested. `docker` and `podman` are wired but untested, because no engine is installed |
| `ORCH_MODEL` | the runner's default | `AGENT_MODEL_REVIEW` |
| `ORCH_CLAUDE_VERSION` | `latest` | The agent's CLI, installed by the server into `$TMPDIR/orch-claude-cli` at start, as review.yml installs it per run. The host's own `claude` is never used |
| `ORCH_PORT` | `8787` | Binds to 127.0.0.1 only |

**`none` runs the agent on this machine as you.** `HOME` is an empty directory and the env is
allowlisted, but the agent's Bash can still read any file you can, by absolute path, including your
`gh` and SSH credentials. Run it only on a PR whose content you trust. Isolation is
`ORCH_SANDBOX`'s job.

Each run leaves `/tmp/orch-<repo>-<pr>-*/`, holding `run.json` (the outcome and every place the
orchestrator stood in for `review.yml`), `runner.log`, the checkout and `output/`.
