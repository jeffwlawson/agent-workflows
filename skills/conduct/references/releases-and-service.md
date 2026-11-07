# Releases and the service

## Checkpoint 3: cut a release

Only where the repo's `CLAUDE.md` (or the release doc it points to) says how, and in exactly its steps. Prepare first, then ask once:

- **What merged since the last tag**: `git log --oneline <last-tag>..origin/<default>`, and each commit's adopter-facing trailer where the repo uses one.
- **The *After merge, by a human* items** of those merges, done or not.
- **No PRD chain mid-run.** A chain that started on the old release and finishes on the new one runs slices under two releases; where the repo's pins are files the chain may add to, the release also misses them. Wait for it, or say why it does not matter here.
- **Where it is cut**: the main checkout, at the tip of origin's default branch, never a worktree. Fetch, and check `git rev-parse HEAD` equals `git ls-remote origin <default>`. A release cut one merge behind has shipped before, and some repos' release scripts refuse anywhere else.

Then run the steps as separate commands, one per call, and read each result before the next. **A refusal can leave the tree half-changed**: in agent-workflows, `npm version` bumps `package.json` and the lockfile before its hook refuses and does not roll them back, so the retry dies on npm's dirty-tree check instead. Follow the release doc's recovery (there, `git checkout -- package.json package-lock.json`) before retrying. Done when the tag's publish run has succeeded and the release carries what the doc says it must.

## Checkpoint 4: restart the service

Only where the repo runs on the self-hosted service, and only through the deployment's own upgrade script (the loop's Unraid deployment: `deploy/unraid/upgrade.sh <version>`, on the Unraid host). The maintainer runs it unless they hand you a way to: it runs on their machines, as root.

The script waits for the worker to hold no job before restarting it, and takes `--now` to skip that. Prepare, then ask once:

- **The version on both machines** (the dispatcher and the agent box), from the deployment's own check where it has one, against the release to move to. Without that output, say *not checked*; invent nothing.
- **What a restart would drop**: with the wait, nothing that is held. With `--now`, every job the worker holds, running and queued; each keeps its trigger label, so the service's start scan dispatches it again (the loop's `docs/deploying-the-service.md`, *Restarts and outages*), and a running job's work so far is lost.
- **The command**, with or without `--now`, and which you recommend.

**Labels after a restart.** Since loop v0.9.4 the service re-queues labelled work at its start scan, so re-add nothing; say so. On an older release, look for trigger labels with no job behind them (no run, no start comment since the label went on) and toggle each, alone.
