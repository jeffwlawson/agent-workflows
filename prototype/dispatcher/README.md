# Dispatcher (#364 prototype)

Runs on the Unraid host and holds the loop App's private key: it is the only thing that does.
It receives the App's webhook through Tailscale Funnel, mints a one-hour token for a single
repository, and hands the job to the orchestrator in the agent box.

```text
GitHub App webhook → Funnel :10000 → 127.0.0.1:8790/github (this)
  verify signature · `proto:review` on an open, same-repo PR · owner allowlisted · sender can push
  token: contents:read, pull_requests:write, issues:read (+ checks/statuses:read if granted)
  → POST WORKER_URL (signed with WORKER_SECRET) → agent box /jobs
```

It needs host networking: libvirt's NAT network admits new connections from the host, not from
containers on Docker's own bridges.

`/mnt/user/appdata/agent-dispatcher/` holds `dispatcher.ts`, `app.pem` and `dispatcher.env`:

```text
APP_ID=<the App's ID>
APP_KEY_FILE=/app/app.pem
GITHUB_WEBHOOK_SECRET=<the App's webhook secret>
WORKER_URL=http://192.168.250.11:8787/jobs
WORKER_SECRET=<the agent box's WEBHOOK_SECRET>
ALLOWED_OWNERS=jeffwlawson
```

```bash
docker run -d --name agent-dispatcher --restart unless-stopped --network host \
  -v /mnt/user/appdata/agent-dispatcher:/app:ro -w /app node:24-alpine node dispatcher.ts
tailscale funnel --bg --https=10000 http://127.0.0.1:8790
```
