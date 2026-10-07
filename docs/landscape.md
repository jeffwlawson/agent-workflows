# The landscape of agent loops on GitHub

Research for #388. It answers three questions, in order: what else turns GitHub issues and pull
requests into agent work, whether this project earns a place beside it, and what to call it.

**Checked 2026-10-07.** Every claim about another project below was read that day from a primary
source: the project's repository, its docs, its vendor's pricing or changelog pages, or the GitHub
and npm registry APIs. Each project's section links the page each dimension came from. This field
moves weekly: GitHub Agentic Workflows tagged four releases in the two days before this was written.
Re-read a row before acting on it. Where a primary source did not settle a point, the row says
**not documented** or **unverified** rather than filling the gap from memory.

`docs/parity.md` compares this project with `mattpocock/course-video-manager` and `mattpocock/sandcastle`
feature by feature. This document does not repeat that comparison. It places both among everything
else.

---

## Contents

1. [What this project is, on the same eight dimensions](#1-what-this-project-is-on-the-same-eight-dimensions)
2. [The survey](#2-the-survey)
3. [GitHub Agentic Workflows, compared directly](#3-github-agentic-workflows-compared-directly)
4. [Does this project earn its place?](#4-does-this-project-earn-its-place)
5. [Names](#5-names)
6. [Follow-ups](#6-follow-ups)

---

## 1. What this project is, on the same eight dimensions

So the survey has something to measure against. Sources are this repository's own `README.md`,
`CONTEXT.md` and `docs/ADOPTING.md`, at v0.7.10.

| Dimension | This project |
|---|---|
| Trigger | **Label.** `agent:implement`, `agent:review`, `agent:fix`, `agent:update-branch`, `agent:follow-ups`, added by a human or by the loop itself |
| Where it runs | **The adopter's GitHub Actions**, on hosted or self-hosted runners. #364 drove the same runners from a self-hosted service outside Actions; #375 writes that contract down |
| Agent | **Claude Code through Sandcastle.** Not swappable today; #367 keeps other agents possible |
| Loop | **Closed and budgeted.** Implement, then review against the issue's acceptance criteria, then automatic fix rounds bounded by `AGENT_MAX_FIX_ROUNDS` (default 3) and an early stop when a round closes nothing, then follow-up issues filed from the findings left out of scope |
| Planning | **Multi-issue.** A PRD parent's sub-issues are built one slice at a time on one PRD branch, each reviewed as a slice round of one PRD PR that a human merges once |
| Credentials | **Split.** The agent's job holds a read-only token and no write credential; a separate publish job on a fresh runner writes as the loop's GitHub App. The **red check** runs the PR's tests over the merge base's source |
| Cost model | **A Claude subscription** (`CLAUDE_CODE_OAUTH_TOKEN`), plus Actions minutes |
| Licence and maturity | MIT, v0.7.10, one maintainer, first commit 2026-07-22. Published to GitHub Packages, which needs a token to install even a public package |

---

## 2. The survey

### 2.1 At a glance

Short values; the sections after the table give each one with its source. "Split" in the
credentials column means the agent's own process holds no credential that can write to the
repository, and something outside it applies the writes.

| Project | Trigger | Runs | Agent swappable | Loop | Multi-issue planning | Credentials split | Cost |
|---|---|---|---|---|---|---|---|
| **This project** | label | Actions | no (Claude) | closed, budgeted | yes, sliced on one branch | yes | subscription + minutes |
| GitHub Agentic Workflows | label, slash command, schedule | Actions | yes, 5 engines | toolkit; samples single-shot | `/plan` creates sub-issues, built as separate PRs | yes | API key or Copilot credits + minutes |
| Copilot cloud agent | assignment, mention, automation | GitHub (on Actions) | model picker; Claude and Codex via Agent HQ | implement; iterate on request | no | bounded, not split | AI credits + minutes |
| Copilot code review | request, automatic | GitHub (on Actions) | no | review; manual hand-off to fix | n/a | n/a | AI credits + minutes |
| OpenAI Codex (cloud) | mention, automatic review | vendor | no (OpenAI) | review; `@codex fix` on request | no | not documented | ChatGPT plan |
| `openai/codex-action` | any Actions event | Actions | model only | building block | no | yes, by recipe | API key + minutes |
| Google Jules | **label `jules`**, schedule, UI | vendor | no (Gemini) | implement, answers comments, CI fixer | no | no | task tiers |
| Cursor Cloud Agents | mention, **label automations** | vendor or self-hosted | yes | implement; loops buildable | no | no | API pricing |
| Cursor Bugbot | automatic, comment | vendor | yes | review + autofix, **max 3 attempts** | n/a | no | usage |
| Devin (+ Devin Review) | comment, automations incl. label | vendor | partly | **closed** (auto-fix review findings, rolling out) | child sessions | no | plan + ACUs |
| Amazon Q Developer for GitHub | **label**, `/q dev` | vendor | no | implement + review, human iterates | no | no | free tier |
| Kiro (web) | **label `kiro`**, `/kiro`, schedule | vendor | partly | implement, fixes from comments | sub-agents, workflows | no | credits |
| `anthropics/claude-code-action` | mention, **label**, assignee, prompt | Actions | model only (Claude) | building blocks | no | no | API or **subscription** + minutes |
| Gemini CLI action | mention, automatic | Actions | model only (Gemini) | separate review and assistant | plan approval, one request | no | API + minutes |
| OpenHands Cloud | **label `openhands`**, mention | vendor | yes | implement, iterate on mention | no | no | free tier + LLM |
| OpenHands Software Factory | **label**, polled | self-hosted or cloud | yes | **closed**: triage, developer, reviewer, watchdog | triage across issues, no decomposition | **per-role tokens** | compute + LLM |
| SWE-agent | CLI | self-hosted | yes (LiteLLM) | implement | no | no | API |
| Aider | CLI | local | yes (LiteLLM) | none | no | no | API |
| AutoCodeRover | CLI | self-hosted | yes | patch only | no | n/a | API |
| Sweep (historic) | label, title prefix | vendor or self-hosted | no | implement, answered comments | no | no | was subscription |
| Open SWE | mention | self-deployed | yes | **closed**: implement, review, CI, feedback | subagents | partial | LLM + infra |
| CodeRabbit | automatic, mention, label | vendor | no | review + autofix on request | issue plan, no code | no | per seat |
| Greptile | automatic, mention, label | vendor or self-hosted | self-hosted only | review; fix runs on your machine | no | n/a | per seat + credits |
| PR-Agent | slash command, events | Actions or self-hosted | yes (LiteLLM) | review + suggestions | no | no | API |
| Qodo | automatic, `/agentic_review` | vendor | unverified | review + fixing agent | no | no | team + credits |
| Ellipsis | config file, mention, schedule | vendor or your AWS | yes (Claude Code, Codex) | review comments only | no | scoped per agent | tokens + 10% |
| Graphite Agent | automatic | vendor | Cursor models for agents | review + fixes | stacks, not issues | no | per seat |
| Sandcastle | script or `run()` | anywhere with Docker | yes, 6 agents | templates up to implement + review | parallel planner | sandboxed, not split | subscription or API |
| `course-video-manager` | label | Actions | no (Claude) | implement, review, act on feedback | yes, on one branch | no | subscription + minutes |
| AIF Handoff | Kanban board, issue import | self-hosted | yes | **closed**, convergence-aware | dependency layers | n/a | API or subscription |
| `dceoy/pr-loop` | a human asks an agent | your agent session | yes | **closed**, 3 rounds default | no | no (single writer) | your agent's |

Four things stand out from the table, and Question 2 rests on them.

- **Labels are common now.** Jules, Amazon Q, Kiro, OpenHands, Cursor's automations,
  `claude-code-action` and GitHub Agentic Workflows all start on a label. A label trigger is not
  what distinguishes this project.
- **Closed loops exist, but few are budgeted or live in the adopter's own Actions.** Bugbot caps
  autofix at three attempts, Devin auto-fixes its own review findings, OpenHands' Software Factory
  and Open SWE close the loop on their own platforms, AIF Handoff stops a loop that stops
  converging, and `pr-loop` runs three review rounds inside one agent session. None of them runs
  as reusable workflows in the adopter's Actions with the round count kept on the pull request.
- **Only GitHub Agentic Workflows and `codex-action` recipes split the agent from its write
  credential the way this project does**, and OpenHands' Software Factory splits it by role.
- **Nothing else builds a multi-issue plan slice by slice on one branch with a review per slice.**
  `course-video-manager` builds slices on one branch but reviews none of them; GitHub Agentic
  Workflows' planner builds each issue as its own PR, in parallel.

### 2.2 Vendor-hosted coding agents

#### GitHub Copilot cloud agent

Renamed from "Copilot coding agent" in April 2026, when its scope widened to research and planning
([changelog, 2026-04-01](https://github.blog/changelog/2026-04-01-research-plan-and-code-with-copilot-cloud-agent/)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Assign an issue to Copilot, the Agents panel, `@copilot` in a PR comment, "Fix with Copilot" on a failed run, the API, and since June 2026 automations on schedules and issue or PR events. No label trigger is documented | [docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github), [automations](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/) |
| Where it runs | GitHub Actions, `ubuntu-latest` by default; larger or self-hosted runners through `copilot-setup-steps.yml`. Sessions cap at 59 minutes | [runners](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/configure-runner-for-coding-agent), [about](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) |
| Agent | A model picker; Anthropic Claude and OpenAI Codex as third-party agents through Agent HQ, in public preview | [third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [changelog](https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/) |
| Loop | Implements, then iterates when a human asks with `@copilot` or "Fix with Copilot" on review comments. No automatic budgeted review-to-fix loop is documented | [docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github) |
| Planning | Can propose a plan before coding; one repository, one branch, one PR per task | [changelog](https://github.blog/changelog/2026-04-01-research-plan-and-code-with-copilot-cloud-agent/) |
| Credentials | Pushes only to `copilot/` branches; answers only users with write access; Actions runs on its PRs need approval; sees only the `copilot` environment's secrets; firewall on by default | [responsible use](https://docs.github.com/en/copilot/responsible-use/copilot-cloud-agent) |
| Cost model | AI credits (1 credit = $0.01, usage-based since 2026-06-01) plus Actions minutes | [announcement](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/), [billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing) |
| Licence and maturity | Closed, on every paid plan; latest changelog seen 2026-07-23 | [changelog](https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/) |

#### GitHub Copilot code review

| Dimension | Finding | Source |
|---|---|---|
| Trigger | A review request, or automatic on PR open per ruleset, optionally on every push | [docs](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| Where it runs | GitHub Actions: standard, larger, or self-hosted through ARC | [runners](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-runners) |
| Agent | "A carefully tuned mix of models"; not selectable | [docs](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| Loop | Review only; handing suggestions to the cloud agent for a fix PR is a manual step, in public preview | [docs](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| Planning | Not applicable | [docs](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| Credentials | Built into GitHub; posts review comments once an org policy enables it. Exact token scope not documented | [docs](https://docs.github.com/en/copilot/concepts/agents/code-review) |
| Cost model | AI credits, about $0.05 to $5 a review by effort level, plus Actions minutes from 2026-06-01 | [changelog](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/) |
| Licence and maturity | Closed, GA; recent changelog 2026-08-27 | [changelog](https://github.blog/changelog/2026-08-27-copilot-code-review-resolution-reasons-and-expanded-capabilities/) |

#### OpenAI Codex (cloud, `@codex` and code review)

Codex's docs moved from `developers.openai.com/codex` to `learn.chatgpt.com/docs`, with permanent
redirects.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `@codex review` in a PR, or automatic review on new PRs; other `@codex` comments start what the docs call a "legacy cloud chat". Assignable through Agent HQ. No label trigger | [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) |
| Where it runs | OpenAI-hosted Codex Cloud, one isolated workspace per task | [cloud](https://learn.chatgpt.com/docs/cloud) |
| Agent | OpenAI models only; the current model names were not confirmed from quoted text | [pricing](https://learn.chatgpt.com/docs/pricing) |
| Loop | Reviews, and `@codex fix` pushes a fix when it has permission; no automatic re-review | [code review](https://learn.chatgpt.com/docs/code-review) |
| Planning | One task at a time; no multi-issue planning documented | [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) |
| Credentials | Repository connected through GitHub; pushes "when it has permission". Scopes not documented | [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) |
| Cost model | A ChatGPT plan (Plus, Pro, Business, Enterprise) with metered credits; an API key gives no access to cloud or GitHub features | [pricing](https://learn.chatgpt.com/docs/pricing) |
| Licence and maturity | Closed, GA | [announcement](https://openai.com/index/codex-now-generally-available/) |

#### `openai/codex-action`

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Any Actions event; `allow-users` and `allow-bots` gate who can fire it | [docs](https://learn.chatgpt.com/docs/github-action) |
| Where it runs | The adopter's Actions runners | [repo](https://github.com/openai/codex-action) |
| Agent | Codex CLI; `model` and `effort` inputs, OpenAI only | [repo](https://github.com/openai/codex-action) |
| Loop | A building block: the action pushes nothing. OpenAI's cookbook has an "autofix CI failures" recipe, one shot | [cookbook](https://developers.openai.com/cookbook/examples/codex/autofix-github-actions) |
| Planning | Not applicable | [docs](https://learn.chatgpt.com/docs/github-action) |
| Credentials | Default `drop-sudo`; sandbox profiles from `read-only` up; the API key goes through a proxy Codex never sees. The recommended pattern is a read-only Codex job and a separate job that writes, the same split as this project | [docs](https://learn.chatgpt.com/docs/github-action) |
| Cost model | OpenAI API usage plus Actions minutes; no ChatGPT sign-in | [docs](https://learn.chatgpt.com/docs/github-action) |
| Licence and maturity | Apache-2.0, about 1,260 stars, `v1.13` on 2026-10-05 | [repo](https://github.com/openai/codex-action) |

#### Google Jules

| Dimension | Finding | Source |
|---|---|---|
| Trigger | The **`jules` issue label**, the web UI, schedules, the API and a CLI; `google-labs-code/jules-action` sends a task from any Actions event | [running tasks](https://jules.google/docs/running-tasks/), [action](https://github.com/google-labs-code/jules-action) |
| Where it runs | A Google-hosted VM; the action only sends the request | [action](https://github.com/google-labs-code/jules-action) |
| Agent | Gemini only (Gemini 3.1 Pro the Pro default from 2026-03-09) | [changelog](https://jules.google/docs/changelog/) |
| Loop | Plans, implements, opens a PR; answers PR comments with commits; a "CI Fixer" fixes failing CI on its own PRs. No cap on the fix loop documented | [changelog](https://jules.google/docs/changelog/), [reactive mode](https://jules.google/docs/changelog/2025-09-23/) |
| Planning | One plan per task, approved or auto-approved; no splitting across issues | [running tasks](https://jules.google/docs/running-tasks/) |
| Credentials | The Jules GitHub App; works on a branch; the action warns that issue-triggered workflows need an allowlist | [running tasks](https://jules.google/docs/running-tasks/) |
| Cost model | Tiers by tasks per day (15, 100, 300); the API takes a key | [home](https://jules.google/) |
| Licence and maturity | Closed service; the action is MIT; API in alpha. Newest changelog entry 2026-03-09, seven months before this check | [changelog](https://jules.google/docs/changelog/), [API](https://developers.google.com/jules/api) |

#### Cursor Cloud Agents

Renamed from "Background Agents".

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `@cursor` on GitHub issues and PRs, Slack, Linear, the API; **automations** fire on schedules and GitHub events, including "Issue label changed" and "Pull request label changed" | [cloud agents](https://cursor.com/docs/cloud-agent), [automations](https://cursor.com/docs/cloud-agent/automations) |
| Where it runs | Cursor-hosted VMs, or self-hosted machines and team pools | [runtime](https://cursor.com/docs/cloud-agent/choose-runtime) |
| Agent | A curated model list, selectable | [cloud agents](https://cursor.com/docs/cloud-agent) |
| Loop | Implements and opens a PR; automations can react to review comments and CI, so a loop can be assembled. No budget beyond spend limits | [automations](https://cursor.com/docs/cloud-agent/automations) |
| Planning | One task per agent; "Cursor Projects" (2026-09-10) adds a coordinator over sub-agents | [changelog](https://cursor.com/changelog) |
| Credentials | A GitHub App over repos, PRs, issues, checks, Actions and workflows, with admin read | [GitHub integration](https://cursor.com/docs/integrations/github) |
| Cost model | The selected model's API pricing, under a spend limit | [cloud agents](https://cursor.com/docs/cloud-agent) |
| Licence and maturity | Closed; hosted GA; automations launched 2026-03-05 | [changelog](https://cursor.com/changelog/03-05-26) |

#### Cursor Bugbot

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Automatic on every PR update, or a `cursor review` / `bugbot run` comment | [docs](https://cursor.com/docs/bugbot) |
| Where it runs | Cursor-hosted | [docs](https://cursor.com/docs/bugbot) |
| Agent | The account's default agent model, so swappable in settings | [docs](https://cursor.com/docs/bugbot) |
| Loop | Review, then **Autofix** starts a cloud agent that pushes fixes, "max 3 attempts per PR to prevent loops". Whether it re-reviews after a fix is not documented | [docs](https://cursor.com/docs/bugbot), [blog](https://cursor.com/blog/bugbot-autofix) |
| Planning | Not applicable | [docs](https://cursor.com/docs/bugbot) |
| Credentials | Repository access to read diffs, comment and publish a check; push rights depend on autofix mode | [docs](https://cursor.com/docs/bugbot) |
| Cost model | Usage-based from June 2026 renewals, about $1 to $1.50 a run; autofix billed as cloud agent use | [blog](https://cursor.com/blog/may-2026-bugbot-changes) |
| Licence and maturity | Closed, GA; autofix GA 2026-02-26 | [blog](https://cursor.com/blog/bugbot-autofix) |

#### Devin, with Devin Review

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `/devin <prompt>` or `/devin review` on a PR; automations on GitHub events including an issue being labelled; a documented `devin` label recipe through Actions | [GitHub](https://docs.devin.ai/integrations/gh.md), [automations](https://docs.devin.ai/product-guides/automations.md) |
| Where it runs | Cognition-hosted; optional VPC on Enterprise | [pricing](https://devin.ai/pricing) |
| Agent | Devin, with frontier models and SWE-2 in an agent selector | [pricing](https://devin.ai/pricing), [release notes](https://docs.devin.ai/release-notes/overview.md) |
| Loop | **Closed.** Devin Review checks each push; on a PR from a Devin session, findings go to that session first, and with "Auto-fix review findings" on, only what it could not fix is posted. "Rolling out gradually" | [Devin Review](https://docs.devin.ai/work-with-devin/devin-review.md) |
| Planning | One session per task; child sessions exist, multi-issue planning not documented | [automations](https://docs.devin.ai/product-guides/automations.md) |
| Credentials | A GitHub App with read and write on contents, PRs, Actions and workflows; the docs advise branch protection before letting it merge | [GitHub](https://docs.devin.ai/integrations/gh.md) |
| Cost model | Plans from free to $200 a month, Teams per seat; reviews use ACUs | [pricing](https://devin.ai/pricing) |
| Licence and maturity | Closed, GA; latest release note 2026-10-05 | [release notes](https://docs.devin.ai/release-notes/overview.md) |

#### Amazon Q Developer for GitHub

Still documented as a preview. AWS is retiring Q Developer's IDE plugins and subscriptions in favour
of Kiro (new sign-ups closed 2026-05-15); the notice does not mention the GitHub integration
([end of support](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | The **"Amazon Q development agent" label**, or `/q dev`; review automatic on PR open, `/q review` again | [docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.md) |
| Where it runs | AWS-hosted, through a GitHub App | [docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.md) |
| Agent | Amazon Q; no model named or selectable | [docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.md) |
| Loop | Implements and reviews; a human iterates with `/q <feedback>` and commits suggested fixes | [feature development](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/github-feature-development.html) |
| Planning | One issue at a time | [feature development](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/github-feature-development.html) |
| Credentials | A GitHub App installed by an org admin; a human merges | [docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.md) |
| Cost model | Free with monthly limits, raised by linking an AWS account | [docs](https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/amazon-q-for-github.md) |
| Licence and maturity | Closed; preview since May 2025; parent product being retired | [preview](https://aws.amazon.com/about-aws/whats-new/2025/05/amazon-q-developer-integration-github-preview-available) |

#### Kiro (web, its GitHub mode)

Added: Q's successor, and label-triggered.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | The **`kiro` label** or `/kiro` on an issue; `/kiro all` or `/kiro fix` on PR comments; schedules | [GitHub](https://kiro.dev/docs/web/github/) |
| Where it runs | Kiro's own sandbox | [GitHub](https://kiro.dev/docs/web/github/) |
| Agent | Kiro, with selectable models and reasoning effort | [autonomous agent](https://kiro.dev/docs/autonomous-agent/) |
| Loop | Implements and fixes from review comments; "Kiro never merges changes automatically"; no automatic reviewer found | [autonomous agent](https://kiro.dev/docs/autonomous-agent/) |
| Planning | Autonomous mode plans and hands parts to sub-agents; "workflows" (2026-09-30) run multi-step plans | [changelog](https://kiro.dev/changelog/web/) |
| Credentials | A GitHub App with write on Actions, Checks, Contents, Issues, PRs and Workflows; works on feature branches | [GitHub](https://kiro.dev/docs/web/github/) |
| Cost model | Credits, free (50) to $200 a month (10,000) | [pricing](https://kiro.dev/pricing/) |
| Licence and maturity | Closed; GA 2026-09-01 | [changelog](https://kiro.dev/changelog/web/) |

#### `anthropics/claude-code-action`

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `@claude` mention, `label_trigger` (default `claude`), `assignee_trigger`, or a `prompt` for any event including cron; write access required by default | [action.yml](https://github.com/anthropics/claude-code-action/blob/main/action.yml) |
| Where it runs | The adopter's Actions runners | [docs](https://code.claude.com/docs/en/github-actions) |
| Agent | Claude Code; model by `--model`; inference through the Anthropic API, Bedrock, Vertex or Foundry. Claude only | [docs](https://code.claude.com/docs/en/github-actions) |
| Loop | Building blocks: an implement recipe and a review recipe. Closing the loop is the adopter's job | [docs](https://code.claude.com/docs/en/github-actions) |
| Planning | One issue or PR per run | [docs](https://code.claude.com/docs/en/github-actions) |
| Credentials | The Claude GitHub App's short-lived repo-scoped token, or `GITHUB_TOKEN`, held in the job the agent runs in. Cannot approve or merge | [security](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) |
| Cost model | API tokens, **or a subscription through `CLAUDE_CODE_OAUTH_TOKEN`**, plus Actions minutes | [security](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md) |
| Licence and maturity | MIT, GA, about 9,440 stars, v1.0.244 on 2026-10-06 | [repo](https://github.com/anthropics/claude-code-action) |

#### Gemini CLI action (`google-github-actions/run-gemini-cli`)

Added: Google's Actions-native counterpart to `claude-code-action`.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `@gemini-cli` mentions (including `/review`, `/triage`); automatic review on PR open and triage on issue open; schedules | [repo](https://github.com/google-github-actions/run-gemini-cli) |
| Where it runs | The adopter's Actions runners | [repo](https://github.com/google-github-actions/run-gemini-cli) |
| Agent | Gemini CLI; model by input, Gemini only | [repo](https://github.com/google-github-actions/run-gemini-cli) |
| Loop | Separate review and assistant workflows; the assistant can commit and push. No loop | [assistant example](https://github.com/google-github-actions/run-gemini-cli/tree/main/examples/workflows/gemini-assistant) |
| Planning | Posts a plan and waits for `/approve`; one request at a time | [assistant example](https://github.com/google-github-actions/run-gemini-cli/tree/main/examples/workflows/gemini-assistant) |
| Credentials | `GITHUB_TOKEN` or a custom App; the examples grant contents, issues and PRs write to the job | [repo](https://github.com/google-github-actions/run-gemini-cli) |
| Cost model | Actions minutes plus Gemini or Vertex usage (inferred; the README states no prices) | [repo](https://github.com/google-github-actions/run-gemini-cli) |
| Licence and maturity | Apache-2.0, about 2,100 stars, v0.1.22 on 2026-04-24 | [repo](https://github.com/google-github-actions/run-gemini-cli) |

### 2.3 Open-source agents with a GitHub mode

#### OpenHands

The repository now presents itself as "Agent Canvas, the self-hosted developer control center for
coding agents and automations" ([README](https://github.com/OpenHands/OpenHands/blob/main/README.md);
`All-Hands-AI/OpenHands` redirects there). **The resolver on the starting list is dropped:** the
`fix-me` label GitHub Action is in the tree at tag `1.6.0`
([resolver README](https://github.com/OpenHands/OpenHands/blob/1.6.0/openhands/resolver/README.md))
and gone from `1.7.0` (2026-05-01) and `main`. Two successors take its place.

**OpenHands Cloud, GitHub integration**

| Dimension | Finding | Source |
|---|---|---|
| Trigger | The **`openhands` label** on an issue, or `@openhands` on an issue or PR | [docs](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md) |
| Where it runs | Vendor-hosted; Enterprise can self-host in a VPC | [pricing](https://openhands.dev/pricing) |
| Agent | OpenHands; bring a key or use its at-cost provider | [pricing](https://openhands.dev/pricing) |
| Loop | Implements and opens a PR; updates it on `@openhands`. No automatic review | [docs](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md) |
| Planning | One issue per trigger | [docs](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md) |
| Credentials | A GitHub App with 8-hour tokens, read and write on Actions, contents, issues, PRs and workflows | [docs](https://docs.openhands.dev/openhands/usage/cloud/github-installation.md) |
| Cost model | Free individual tier (10 conversations a day) plus LLM usage | [pricing](https://openhands.dev/pricing) |
| Licence and maturity | Repository MIT, about 90,200 stars, v1.25.0 on 2026-10-06 | [repo](https://github.com/OpenHands/OpenHands) |

**OpenHands Software Factory (Agent Canvas automations)**

The nearest open-source relative of this project's loop.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Labels, found by **polling** on a cron (`ready-for-dev` for the developer, `openhands-review` for the reviewer) | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md) |
| Where it runs | Agent Canvas, self-hosted, in per-conversation Docker containers; or OpenHands Cloud | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md), [issue to PR](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt/issue-to-pr.md) |
| Agent | OpenHands, or Claude Code, Codex, Gemini or any ACP agent | [README](https://github.com/OpenHands/OpenHands/blob/main/README.md) |
| Loop | **Closed:** triage, developer, reviewer and a watchdog that merges once independent acceptance statuses pass. "Failed checks lead to revisions"; no iteration budget documented | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md) |
| Planning | Triage prioritises, checks dependencies and writes acceptance criteria across issues, run in parallel; no decomposition into sub-issues | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md) |
| Credentials | **One fine-grained PAT per role**; the reviewer "can publish findings and statuses but cannot push code" | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md) |
| Cost model | Your compute plus LLM tokens | [issue to PR](https://docs.openhands.dev/openhands/usage/agent-canvas/prebuilt/issue-to-pr.md) |
| Licence and maturity | MIT; a walkthrough needing Agent Canvas 1.24.0 or later, with no preview label | [software factory](https://docs.openhands.dev/openhands/usage/use-cases/software-factory.md) |

#### SWE-agent (and mini-swe-agent)

Its README now recommends mini-swe-agent instead
([README](https://github.com/SWE-agent/SWE-agent/blob/main/README.md)). Kept as a research agent with
a GitHub-issue input, not a GitHub integration.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | CLI only: `sweagent run --problem_statement.github_url=<issue>`. mini-swe-agent is CLI or library, with no GitHub intake found | [hello world](https://swe-agent.com/latest/usage/hello_world/), [mini README](https://github.com/SWE-agent/mini-swe-agent/blob/main/README.md) |
| Where it runs | Self-hosted, locally or in Docker | [hello world](https://swe-agent.com/latest/usage/hello_world/) |
| Agent | Its own; any LiteLLM model | [keys](https://swe-agent.com/latest/installation/keys/) |
| Loop | Implement only; `--actions.open_pr` opens a PR when solved | [CLI tutorial](https://swe-agent.com/latest/usage/cl_tutorial/) |
| Planning | One issue per run | [CLI tutorial](https://swe-agent.com/latest/usage/cl_tutorial/) |
| Credentials | A `GITHUB_TOKEN` from the environment, which can be passed into the agent's tools | [custom tools](https://swe-agent.com/latest/usage/adding_custom_tools/) |
| Cost model | API tokens, with per-instance cost limits | [keys](https://swe-agent.com/latest/installation/keys/) |
| Licence and maturity | MIT, about 20,500 stars, v1.1.0 on 2025-05-22; mini-swe-agent v2.4.6 on 2026-07-23 | [repo](https://github.com/SWE-agent/SWE-agent) |

#### Aider

**Not comparable**, recorded for completeness: it has no GitHub mode.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | CLI only; `aider --message` does one thing and exits | [scripting](https://aider.chat/docs/scripting.html) |
| Where it runs | The user's machine, or CI wired by hand | [scripting](https://aider.chat/docs/scripting.html) |
| Agent | Aider; any LiteLLM model | [models](https://aider.chat/docs/llms/other.html) |
| Loop | None; an interactive pair programmer that commits locally | [scripting](https://aider.chat/docs/scripting.html) |
| Planning | One task per session | [scripting](https://aider.chat/docs/scripting.html) |
| Credentials | The user's own git credentials; no GitHub API use | [scripting](https://aider.chat/docs/scripting.html) |
| Cost model | API tokens | [models](https://aider.chat/docs/llms/other.html) |
| Licence and maturity | Apache-2.0, about 49,400 stars, v0.86.0 on 2025-08-09, last push 2026-05-22 | [repo](https://github.com/Aider-AI/aider) |

#### AutoCodeRover

**Effectively dormant:** Sonar acquired it in February 2025
([press release](https://www.sonarsource.com/company/press-releases/sonar-acquires-autocoderover-to-supercharge-developers-with-ai-agents/)),
and `nus-apr/auto-code-rover` redirects to a "public version" at `AutoCodeRoverSG`.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | CLI only: `app/main.py github-issue` with a clone link and issue link | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Where it runs | Self-hosted, locally or in Docker | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Agent | Its own AST-aware agent; several providers plus any LiteLLM model | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Loop | Writes a patch; opening a PR is not documented | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Planning | One issue per run | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Credentials | Clone access only; it outputs a patch | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Cost model | API tokens | [README](https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md) |
| Licence and maturity | SONAR Source-Available License v1.0; v1.1.0 on 2024-09-10, last push 2025-04-24 | [repo](https://github.com/AutoCodeRoverSG/auto-code-rover) |

#### Sweep (historic)

**Pivoted:** the README now says only "We're now building an AI coding assistant for JetBrains"
([README](https://github.com/sweepai/sweep/blob/main/README.md)). Recorded from its last GitHub-bot
README, at tag `sweep-sandbox-v1`.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | An issue title starting "Sweep:", or the "Sweep" label | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Where it runs | A hosted GitHub App, or self-hosted from Docker | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Agent | GPT-4 and GPT-3.5; not swappable | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Loop | Implement and open a PR, then address comments on it | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Planning | One issue per PR, many in parallel | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Credentials | GitHub App installation; scopes not documented | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Cost model | Was a free tier and Sweep Pro at $480 a month | [README at tag](https://github.com/sweepai/sweep/blob/sweep-sandbox-v1/README.md) |
| Licence and maturity | Now "Sweep Enterprise Edition"; last release 2023-09-11 | [repo](https://github.com/sweepai/sweep) |

#### Open SWE (`langchain-ai/open-swe`)

Added: an open-source closed loop with a GitHub trigger.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `@openswe` on an issue or PR (configurable); also Slack, Linear, a dashboard, schedules | [installation](https://github.com/langchain-ai/open-swe/blob/main/docs/INSTALLATION.md) |
| Where it runs | Self-deployed on LangGraph Platform or a standalone Agent Server (production needs a licence key); sandboxes on LangSmith, Daytona, Modal and others | [customisation](https://github.com/langchain-ai/open-swe/blob/main/docs/CUSTOMIZATION.md) |
| Agent | Deep Agents on LangGraph; model by `LLM_MODEL_ID` | [customisation](https://github.com/langchain-ai/open-swe/blob/main/docs/CUSTOMIZATION.md) |
| Loop | **Closed:** implements, opens a PR, reviews, "monitors CI, and responds to feedback" | [README](https://github.com/langchain-ai/open-swe/blob/main/README.md) |
| Planning | A plan step and parallel subagents; multi-issue planning not documented | [README](https://github.com/langchain-ai/open-swe/blob/main/README.md) |
| Credentials | Installation-wide App access through a runtime-minted proxy token; the README says approvals "guard detected Git pushes, not every possible shell or API write" | [README](https://github.com/langchain-ai/open-swe/blob/main/README.md) |
| Cost model | LLM tokens plus LangSmith or LangGraph infrastructure and sandboxes | [customisation](https://github.com/langchain-ai/open-swe/blob/main/docs/CUSTOMIZATION.md) |
| Licence and maturity | MIT; "under active development… not accepting issues or external contributions" | [README](https://github.com/langchain-ai/open-swe/blob/main/README.md) |

### 2.4 Agent PR reviewers

These review; several now fix too. None implements an issue, so none is a whole substitute, but a
reviewer plus a hosted implementer is the most common way people assemble what this project packages.

#### CodeRabbit

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Automatic on every eligible PR; can be limited by label or branch; `@coderabbitai review` | [auto review](https://docs.coderabbit.ai/configuration/auto-review.md) |
| Where it runs | Vendor-hosted; self-hosted on Enterprise | [self-hosted](https://docs.coderabbit.ai/self-hosted/overview.md) |
| Agent | A vendor-chosen mix of models, deliberately not user-selectable | [blog](https://www.coderabbit.ai/blog/why-users-shouldnt-choose-their-own-llm-models-choice-is-not-always-good) |
| Loop | Review, plus `@coderabbitai autofix` on request, pushing to the branch or a stacked PR | [autofix](https://docs.coderabbit.ai/finishing-touches/autofix.md) |
| Planning | `@coderabbitai plan` or a label posts a coding plan on an issue, for another agent to carry out | [planner](https://docs.coderabbit.ai/issues/planner/github.md) |
| Credentials | Contents, issues, PRs and statuses write (from the self-hosted App setup; the cloud App unverified) | [GitHub App](https://docs.coderabbit.ai/self-hosted/github) |
| Cost model | Per developer, $24 to $72 a month; free on public repositories | [pricing](https://www.coderabbit.ai/pricing) |
| Licence and maturity | Closed; latest changelog 2026-10-05 | [changelog](https://docs.coderabbit.ai/changelog) |

#### Greptile

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Automatic on PR open, `@greptileai`, label rules | [triggers](https://www.greptile.com/docs/code-review-bot/trigger-code-review) |
| Where it runs | Vendor-hosted, or self-hosted with Docker Compose on Enterprise | [self-host](https://www.greptile.com/docs/security/selfhost) |
| Agent | Hosted model not named; self-hosters choose any provider | [self-host](https://www.greptile.com/docs/security/selfhost) |
| Loop | Review only; "Fix with your Agent" sends a comment to an agent on your own machine, and Greptile never commits | [fix with your agent](https://www.greptile.com/docs/integrations/fix-with-your-agent) |
| Planning | One PR at a time | [changelog](https://www.greptile.com/docs/changelog) |
| Credentials | A GitHub App on selected repos; permissions not listed | [integration](https://www.greptile.com/docs/integrations/github-gitlab-integration) |
| Cost model | $30 a seat with credits, 1 to 10 a review by tier; free for non-commercial OSS | [pricing](https://www.greptile.com/pricing) |
| Licence and maturity | Closed; latest changelog 2026-09-25 | [changelog](https://www.greptile.com/docs/changelog) |

#### PR-Agent

Donated by Qodo and community-run; `qodo-ai/pr-agent` redirects to `The-PR-Agent/pr-agent`.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Slash commands (`/review`, `/improve`, `/describe`), or PR events when wired as an Action | [repo](https://github.com/the-pr-agent/pr-agent) |
| Where it runs | Actions, CLI, Docker, a webhook server; GitLab, Bitbucket and Azure DevOps too | [repo](https://github.com/the-pr-agent/pr-agent) |
| Agent | Any model through LiteLLM | [repo](https://github.com/the-pr-agent/pr-agent) |
| Loop | Review plus code suggestions; no fixing agent | [repo](https://github.com/the-pr-agent/pr-agent) |
| Planning | One PR at a time | [repo](https://github.com/the-pr-agent/pr-agent) |
| Credentials | The workflow's `GITHUB_TOKEN` in Actions mode | [repo](https://github.com/the-pr-agent/pr-agent) |
| Cost model | Free software; your model provider's bill | [repo](https://github.com/the-pr-agent/pr-agent) |
| Licence and maturity | MIT, about 13,300 stars, v0.47.0 on 2026-10-02 | [releases](https://github.com/The-PR-Agent/pr-agent/releases) |

#### Qodo (formerly Qodo Merge)

"We no longer use these product names" ([Qodo](https://www.qodo.ai/formerly-qodo-merge/)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Automatic on PR open or ready; `/agentic_review` | [PR use](https://docs.qodo.ai/code-review/use-qodo-in-prs) |
| Where it runs | Vendor-hosted; on-prem on Enterprise | [pricing](https://www.qodo.ai/pricing/) |
| Agent | Defaults are GPT-5.2, Gemini 2.5 Pro and Claude Haiku 4.5; switching unverified | [blog](https://www.qodo.ai/blog/qodos-default-reviewers-why-we-picked-gpt-5-2-gemini-2-5-pro-and-claude-haiku-4-5/) |
| Loop | Review plus a fixing agent, by `/fix` or automatic above a severity; opens a separate fix PR by default | [configuration](https://docs.qodo.ai/configuration/configuration-and-command-reference) |
| Planning | PRs only; cross-repo triage queue in 3.0 | [what's new](https://docs.qodo.ai/whats-new) |
| Credentials | A Marketplace App; permissions not listed | [PR use](https://docs.qodo.ai/code-review/use-qodo-in-prs) |
| Cost model | $30 a month for a team plus credits; free for qualifying OSS | [pricing](https://www.qodo.ai/pricing/), [OSS](https://docs.qodo.ai/open-source-program) |
| Licence and maturity | Closed; Qodo 3.0 on 2026-10-01 | [what's new](https://docs.qodo.ai/whats-new) |

#### Ellipsis

Repositioned as a hosted platform for running Claude Code or Codex agents, with review one feature
among several ([docs](https://www.ellipsis.dev/docs)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Opt in with `.ellipsis/code-review.yaml`; `@ellipsis`, Slack, Linear, schedules, webhooks | [docs](https://www.ellipsis.dev/docs) |
| Where it runs | Vendor sandboxes, or the customer's AWS account | [pricing](https://www.ellipsis.dev/pricing) |
| Agent | Claude Code or Codex, chosen in YAML | [home](https://www.ellipsis.dev) |
| Loop | The review "never approves, requests changes, or pushes commits"; separate agents can open PRs | [docs](https://www.ellipsis.dev/docs) |
| Planning | None documented | [docs](https://www.ellipsis.dev/docs) |
| Credentials | One App; each agent's token narrowed to what its YAML grants, with spend caps | [GitHub](https://www.ellipsis.dev/docs/integrations/github) |
| Cost model | Token cost plus 10%, no seats | [pricing](https://www.ellipsis.dev/pricing) |
| Licence and maturity | Closed; no changelog date found | [docs](https://www.ellipsis.dev/docs) |

#### Graphite Agent (formerly Diamond)

Diamond became Graphite Agent on 2025-10-07
([Graphite](https://graphite.com/blog/introducing-graphite-agent-and-pricing)), and Cursor agreed to
buy Graphite on 2025-12-19 ([Cursor](https://cursor.com/blog/graphite)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Automatic on every new PR in selected repos | [setup](https://graphite.com/docs/ai-reviews-setup) |
| Where it runs | Graphite's servers; its coding agents run as Cursor cloud agents | [agents](https://graphite.com/docs/background-agents) |
| Agent | Claude for review; Cursor's model choice for agents | [privacy](https://graphite.com/docs/privacy-and-security) |
| Loop | Review, with fixes applied from the PR page or by an agent committing to the branch | [agents](https://graphite.com/docs/background-agents) |
| Planning | PRs and stacks, not issues | [agents](https://graphite.com/docs/background-agents) |
| Credentials | Write on Actions, checks, contents, PRs and workflows | [privacy](https://graphite.com/docs/privacy-and-security) |
| Cost model | Per user, free to $40 a month; unlimited reviews from Team | [pricing](https://graphite.com/pricing) |
| Licence and maturity | Closed; latest changelog date not checked | [pricing](https://graphite.com/pricing) |

### 2.5 Loop and workflow frameworks

GitHub Agentic Workflows has [§3](#3-github-agentic-workflows-compared-directly) to itself.

#### Sandcastle (`mattpocock/sandcastle`, npm `@ai-hero/sandcastle`)

The library this project runs on. Its README: "Orchestrate sandboxed coding agents in TypeScript
with `sandcastle.run()`" ([README](https://github.com/mattpocock/sandcastle/blob/main/README.md)).

| Dimension | Finding | Source |
|---|---|---|
| Trigger | A script (`npx tsx .sandcastle/main.ts`) or `run()` from anywhere; `init` templates pull issues by a `Sandcastle` label, but do not fire on one | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Where it runs | Docker, Podman, Vercel, or a custom provider | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Agent | **Swappable:** Claude Code, Codex, Pi, Cursor, OpenCode, Copilot | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Loop | Templates up to `sequential-reviewer` and `parallel-planner-with-review`; no budget | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Planning | `parallel-planner` builds independent issues on separate branches, then merges | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Credentials | The agent is in a container; repository writes are whatever the caller grants | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Cost model | Subscription OAuth token or API key, plus your compute | [README](https://github.com/mattpocock/sandcastle/blob/main/README.md) |
| Licence and maturity | MIT, about 8,300 stars, npm 0.12.0 on 2026-06-29 | [repo](https://github.com/mattpocock/sandcastle), [npm](https://www.npmjs.com/package/@ai-hero/sandcastle) |

Two facts matter for this document. Sandcastle **declines** to ship "large, opinionated" workflow
templates in its `init`, and says an opinionated workflow "can be distributed as its own template
pack or repo … versioned on its own cadence rather than pinned to Sandcastle's releases"
([`.out-of-scope/bundled-workflow-templates.md`](https://github.com/mattpocock/sandcastle/blob/main/.out-of-scope/bundled-workflow-templates.md)).
And it dogfoods an `agent:*` label loop of its own, with runners under a directory named
`.sandcastle/agent-workflows/` ([tree](https://github.com/mattpocock/sandcastle/tree/main/.sandcastle)).
That loop's agent job holds `contents: write`, and it refuses any issue with sub-issues.

#### `mattpocock/course-video-manager`

`docs/parity.md` compares it feature by feature; the eight dimensions only.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `agent:*` labels | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Where it runs | Its own Actions; not packaged for anyone else | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Agent | Claude Code through Sandcastle | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Loop | Implement, review, act on PR feedback, update branch; no fix-round budget, red check or follow-up filing | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Planning | `agent:to-issues` splits a PRD; `agent-implement-prd` builds sub-issues one at a time on one branch, without a review per slice | [`agent-implement-prd.yml`](https://github.com/mattpocock/course-video-manager/blob/main/.github/workflows/agent-implement-prd.yml) |
| Credentials | The agent's job holds `contents: write` and `GITHUB_TOKEN` or `AGENT_PAT` | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Cost model | `CLAUDE_CODE_OAUTH_TOKEN`, plus Actions minutes | [workflows](https://github.com/mattpocock/course-video-manager/tree/main/.github/workflows) |
| Licence and maturity | No licence on the repository; about 785 stars; an application, not a product | [repo](https://github.com/mattpocock/course-video-manager) |

#### AIF Handoff (`lee-to/aif-handoff`)

Added: a self-hosted board with a closed, convergence-aware loop.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | Tasks on its own Kanban board; an opt-in "GitHub Issue-to-PR mode" imports issues | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Where it runs | Self-hosted (Node or Docker) | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Agent | Swappable runtimes: Claude, Codex, OpenRouter, OpenCode | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Loop | **Closed:** review feedback sends a task back to implementing; when the loop "stops converging" it is handed to a human | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Planning | A planning stage and dependency layers inside one task; one human-merged PR per task | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Credentials | Not documented in the README | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Cost model | API, or a subscription through the official CLI transport | [README](https://github.com/lee-to/aif-handoff/blob/main/README.md) |
| Licence and maturity | MIT, 299 stars, created 2026-03-29, last push 2026-10-03 | [repo](https://github.com/lee-to/aif-handoff) |

#### `dceoy/pr-loop`

Added, and the closest match by description: "GitHub-native, race-safe Agentic Issue-Driven
Development skills".

| Dimension | Finding | Source |
|---|---|---|
| Trigger | A human asks an agent to run a skill on an issue or PR URL; a reusable workflow runs the review skill only | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Where it runs | Inside whatever agent session runs the skill; the review workflow in Actions | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Agent | Any agent runtime with skills; the bundled workflow uses Claude Code | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Loop | **Closed and bounded:** `issue-to-pr`, `pr-review` on a frozen head, `pr-feedback-triage`, repeated until a stable head; 3 review rounds by default | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Planning | One issue | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Credentials | "Authenticated GitHub access through `gh`" in the agent's session; a single-writer rule, not a split | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Cost model | The agent's own; the review workflow takes `CLAUDE_CODE_OAUTH_TOKEN` | [README](https://github.com/dceoy/pr-loop/blob/main/README.md) |
| Licence and maturity | AGPL-3.0, 0 stars, created 2026-08-27 | [repo](https://github.com/dceoy/pr-loop) |

### 2.6 Looked at and not surveyed

- **Factory's `droid-action`** ([repo](https://github.com/Factory-AI/droid-action)): Actions,
  `@droid` commands, review-led; 56 stars and no licence. Below the bar of "significant".
- **Sourcegraph Amp, Augment, Warp, Codegen, Kodus, Continue's workflows, Dagger agents:** not
  checked. None was found with a label- or issue-driven GitHub loop in the searches that found the
  rest; that is an absence of evidence, not evidence of absence.

---

## 3. GitHub Agentic Workflows, compared directly

[`github/gh-aw`](https://github.com/github/gh-aw) is a GitHub CLI extension. A workflow is Markdown,
frontmatter plus instructions, that `gh aw compile` turns into a `.lock.yml` Actions workflow.

| Dimension | Finding | Source |
|---|---|---|
| Trigger | `label_command`, which removes the label so it can be re-applied; `slash_command`; schedule; dispatch | [label ops](https://github.github.com/gh-aw/patterns/label-ops/) |
| Where it runs | GitHub Actions only, including self-hosted runner groups | [FAQ](https://github.github.com/gh-aw/reference/faq/), [changelog](https://github.blog/changelog/2026-06-11-github-agentic-workflows-is-now-in-public-preview) |
| Agent | **Swappable:** Copilot (default), Claude Code, Codex, Gemini, Pi | [engines](https://github.github.com/gh-aw/reference/engines/) |
| Loop | A toolkit. Its samples are single-shot: `pr-fix` fixes CI or follows a comment, once; `grumpy-reviewer` reviews; `repo-assist` caps open PRs at 8 but keeps no round budget per PR | [pr-fix](https://github.com/githubnext/agentics/blob/main/workflows/pr-fix.md), [grumpy-reviewer](https://github.com/githubnext/agentics/blob/main/workflows/grumpy-reviewer.md), [repo-assist](https://github.com/githubnext/agentics/blob/main/workflows/repo-assist.md) |
| Planning | `/plan` creates up to 5 sub-issues; each is assigned to the Copilot agent and built **as a separate PR, in parallel**; "every transition is a human checkpoint" | [plan.md](https://github.com/github/gh-aw/blob/main/.github/workflows/plan.md), [research-plan-assign](https://github.github.com/gh-aw/patterns/research-plan-assign-ops/) |
| Credentials | **Split, like ours.** The agent job is read-only and firewalled; writes are declared **safe outputs** applied in separate permission-scoped jobs after threat detection | [safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/), [FAQ](https://github.github.com/gh-aw/reference/faq/) |
| Cost model | Actions minutes plus inference: Copilot AI credits with a per-run `max-ai-credits` cap, or the engine's API key. **A Claude subscription is refused:** "Claude subscription OAuth tokens such as `CLAUDE_CODE_OAUTH_TOKEN` are not supported" | [FAQ](https://github.github.com/gh-aw/reference/faq/), [about](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows) |
| Licence and maturity | MIT, about 5,355 stars, created 2025-08-12. Newest stable release v0.89.21 (2026-09-23); newest tag the prerelease v0.91.4 (2026-10-06). **Public preview**, "subject to change" | [repo](https://github.com/github/gh-aw), [releases](https://github.com/github/gh-aw/releases), [about](https://docs.github.com/en/copilot/concepts/agents/about-github-agentic-workflows) |

### What each has that the other does not

| | gh-aw | This project |
|---|:--:|:--:|
| Label trigger | ✅ | ✅ |
| Agent job holds no write credential | ✅ | ✅ |
| Threat detection between agent output and the write | ✅ | ❌ (the publish job checks the bundle against what the gate read; it does not scan content) |
| Network firewall around the agent | ✅ | ❌ |
| Several engines | ✅ | ❌ (#367) |
| Runs on a Claude subscription | ❌ | ✅ |
| Implement → review → **budgeted** fix rounds, counted on the PR | ❌ | ✅ |
| Review against the issue's acceptance criteria | ❌ (writable as a prompt) | ✅ |
| A plan built slice by slice on one branch, one review per slice | ❌ (parallel PRs) | ✅ |
| Red check: the PR's tests over the merge base | ❌ (`create-check-run` exists as a primitive) | ✅ |
| Follow-up issues filed from review findings at merge | 🟡 (`create-issue` exists; no sample does this) | ✅ |
| `init` and `doctor` for the silent failures | 🟡 (`gh aw` compiles, installs and audits) | ✅ |
| A seam to run outside Actions | ❌ | 🟡 (#364 proved it; #375 writes it) |
| Maintained by GitHub, released several times a week | ✅ | ❌ |

### Could this loop be rebuilt as gh-aw workflows?

Mostly, and that is the honest centre of Question 2. Every write this loop makes has a safe output:
`create-pull-request`, `push-to-pull-request-branch`, `submit-pull-request-review`,
`resolve-pull-request-review-thread`, `add-labels`, `remove-labels`, `create-issue`,
`link-sub-issue`, `create-check-run` ([safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/)).
`label_command` chains workflows the way our labels do, and `dispatch-workflow` chains them without
a label.

**What a rebuild would lose:**

- **Subscription billing.** gh-aw refuses `CLAUDE_CODE_OAUTH_TOKEN`. For one maintainer on a
  Claude subscription that is the difference between a fixed monthly cost and a metered one.
- **The orchestrator seam.** gh-aw runs through Actions only; #364's service-driven run has no
  counterpart.
- **Deterministic bookkeeping.** Our round count, early stop, slice ranges and verdict history are
  TypeScript under test. In gh-aw, the same logic would be prompt text the agent follows, or
  custom jobs beside the compiled workflow, which is our shape again.
- **Stability.** gh-aw is a public preview that tagged four releases in two days.

**What it would gain:** several engines for free, a firewall, threat detection, GitHub's
maintenance, and a name people already search for.

---

## 4. Does this project earn its place?

### Duplicative

- **Implementing a single issue from a label.** Jules, Kiro, OpenHands Cloud, Amazon Q,
  `claude-code-action` and gh-aw all do it, most with less setup. For an adopter who wants only
  that, `claude-code-action` with `label_trigger` is one file.
- **Reviewing a PR.** Copilot code review, CodeRabbit, Greptile, Qodo, Bugbot and PR-Agent are
  mature and polished. Ours is no reason to adopt the loop on its own.
- **The credential split.** gh-aw's safe outputs implement the same idea more thoroughly, with a
  firewall and threat detection, and `codex-action` recommends it.
- **A closed loop, as an idea.** Bugbot (capped at 3), Devin Review, OpenHands' Software Factory,
  Open SWE, AIF Handoff and `pr-loop` all close implement → review → fix in some form.

### Unique

No surveyed project combines these; several are found nowhere else.

1. **A multi-issue plan built slice by slice on one branch, with a review round per slice** and
   one human merge at the end. `course-video-manager` builds on one branch without reviewing; gh-aw
   builds in parallel PRs; nobody else has slices at all.
2. **The red check.** No other project runs a PR's new tests over the merge base and hands the
   reviewer what came out red.
3. **A budgeted fix loop counted on GitHub's own surfaces.** Rounds are statuses on the PR, the
   early stop matches finding ids, and a human can step in with a label, a reply or a push. Bugbot
   has a cap but no early stop and no review against criteria; `pr-loop` has rounds but inside one
   agent session.
4. **Review against the issue's acceptance criteria**, with follow-up issues filed at merge from
   what was out of scope.
5. **A write-free agent job and a subscription token together.** gh-aw has the split and refuses
   the subscription; `claude-code-action`, Sandcastle and `course-video-manager` take the
   subscription and give the agent's job write access.

### Better and worse

**Better** for one kind of user: someone already paying for a Claude subscription, who wants the
whole loop in their own repository's Actions, every step on GitHub's own surfaces (labels, reviews,
threads, statuses), no vendor platform, and a reviewer that holds the agent to the issue as written.

**Worse** in ways an outside user would hit at once:

- **One agent.** Every serious competitor offers a choice; ours is Claude only until #367.
- **Install friction.** GitHub Packages needs a token even to run `init` (README, *Installing it*).
  `doctor` exists because there are many silent failures to check for.
- **Bus factor of one**, at 0.x, eleven weeks old.
- **No firewall or content threat detection** around the agent, where gh-aw has both.
- **Actions minutes on every run**, where a hosted agent bills only inference.
- **A subscription is one person's.** A team's loop on one person's subscription is a question
  about Anthropic's terms that an API-key product does not raise. `claude-code-action`'s own
  documentation of `CLAUDE_CODE_OAUTH_TOKEN` is the evidence that running it in Actions is
  supported; whether sharing it across a team is, this research did not settle.

### Recommendation: productise it

**Productise it**, for a gap that is narrow but real: **a closed, budgeted, label-driven loop from
issue to reviewed PR, including multi-issue plans built and reviewed slice by slice, that runs in the
adopter's own Actions on their own Claude subscription, with the agent holding no write
credential.** It is for solo maintainers and small teams who already pay for Claude, plan work as
issues with acceptance criteria, and want an auditable loop rather than a hosted platform.

The reasons, in order:

1. **The gap holds up under the survey.** Items 1, 2 and 5 of *Unique* exist nowhere else checked,
   and item 3 exists only in weaker forms.
2. **Narrowing has no good destination.** Sandcastle has recorded large, opinionated workflow
   templates as out of scope and asks for them to be distributed as their own repository, which is
   what this project already is. gh-aw is the only plausible host, and moving
   there gives up the subscription billing that is half the audience's reason to choose this, and
   lands on a preview that changes several times a week.
3. **Keeping it personal leaves no outside user well served.** The nearest single alternative,
   OpenHands' Software Factory, needs a self-hosted Agent Canvas and has no slices or budget;
   gh-aw needs the user to write the loop themselves. Neither is "use that instead".

**Two conditions would reverse it**, and are worth watching: gh-aw accepting subscription tokens,
or gh-aw (or `githubnext/agentics`) shipping a budgeted review → fix loop. Either would make
*narrow it* right: offer the PRD chain and the red check as gh-aw workflows, and stop maintaining
the rest.

**What productising costs**, which the follow-ups below carry: the public npm registry, a
distinctive name, and #367's second agent sooner rather than later.

---

## 5. Names

### 5.1 The landscape's names, by style

| Style | Names | How they read |
|---|---|---|
| **Vendor brand + product** | GitHub Copilot, Copilot code review, Amazon Q Developer, Cursor Bugbot, Cursor Cloud Agents, Qodo, Graphite Agent, OpenAI Codex | Lean on the parent brand; meaningless without it |
| **Persona** | Devin, Jules, Kiro, Claude, Gemini | A colleague's name; says nothing about the job |
| **Descriptive, generic** | GitHub Agentic Workflows (`gh aw`), Agent Canvas, Software Factory, PR-Agent, Open SWE, SWE-agent, `claude-code-action`, `codex-action`, `run-gemini-cli`, `pr-loop`, **agent-workflows** | Say what they are; collide with each other and are hard to search |
| **Metaphor or coined** | Sandcastle, CodeRabbit, Greptile, Aider, OpenHands, Sweep, Bugbot, Ellipsis, AutoCodeRover | Memorable; the meaning is learned, not read |

**Where a new name lands.** Descriptive names are crowded and blur together: `agent-workflows`
sits between "GitHub Agentic Workflows" and Sandcastle's own `.sandcastle/agent-workflows/`
directory, so the current name collides twice. Personas belong to vendors with marketing budgets.
A **compound** that is descriptive but coined (one word, made of two the reader already knows)
stands out from both: it reads at a glance, as the descriptive names do, and searches cleanly, as
the metaphors do. None of the surveyed projects uses that style.

### 5.2 The criteria

A name must:

1. say what the project does: **a label starts an agent loop on issues and PRs**;
2. not contain "Claude" (#367, and Anthropic's trademark);
3. not lead with "GitHub";
4. not borrow Sandcastle's name;
5. be short enough to type as a command: `<name> init`, `<name> doctor`.

### 5.3 How Question 2 changes this

With *productise*, the name has to work for strangers: free on the public npm registry unscoped,
searchable, and not one a nearby product already uses. Had the answer been *keep it personal*, the
only reason to rename would be to get out from beside gh-aw, and almost any free name would do. Had
it been *narrow it* into gh-aw workflows, the name would describe a workflow pack, and a
descriptive name inside gh-aw's vocabulary would be right rather than a collision.

### 5.4 The shortlist

Collision checks, all on 2026-10-07:

- **npm:** `npm view <name>` against the public registry; free means `E404`.
- **GitHub:** whether `github.com/<name>` is a user or organization, and a repository name search.
- **Marketplace:** the Actions search at `github.com/marketplace?type=actions&query=<name>`. The
  Apps search could not be read and is **not checked**.
- **Trademarks:** web searches for products of the same name in software and AI, not a registry
  search. "None found" is not clearance; the finalist needs a USPTO and EUIPO search before
  anything is registered.

| Candidate | Fit | npm | GitHub | Marketplace | Trademarks and products | Risk |
|---|---|---|---|---|---|---|
| **labelloop** *(raised)* | Says exactly what it does: a label, a loop | free | `github.com/labelloop` is an **organization**, no public repos, for [Labelloop](https://labelloop.app), a German B2B fashion-wholesale SaaS; 2 small unrelated repos | none | The fashion SaaS above, no ® shown; nothing in dev tools or AI | low-medium |
| **tideloop** *(raised)* | Pleasant, but "tide" says nothing about labels or agents; fails criterion 1 | free | a user exists; 2 repos, 0 stars | none | None in software; [Tidepool Loop](https://en.wikipedia.org/wiki/Tidepool_(company)) is an insulin app | low |
| **baton** *(raised)* | Hand-off between runs; does not say "label" | **taken** (`baton`, 2022) | user exists; 1,761 repos, `django-baton` 997 stars | `pr-assignee-baton`, `release-baton` | [Baton](https://aiindigo.com/tool/baton), a desktop app orchestrating Claude Code and Codex agents, launched April 2026 | **high** |
| **loopwright** *(raised)* | A maker of loops; does not say "label" | free | user exists; 20 repos, top hit [`dtkmn/loopwright`](https://github.com/dtkmn/loopwright) "Flight recorder for AI agent loops" | none | none found | medium |
| **shepherd** *(raised)* | Shepherds a PR to merge; does not say "label" | **taken** (`shepherd`, 2022) | user exists; 3,881 repos, [`shipshapecode/shepherd`](https://github.com/shipshapecode/shepherd) 13.8k stars, [`shepherd-agents/shepherd`](https://github.com/shepherd-agents/shepherd) 2.5k stars | `fork-shepherd` | [Korso Shepherd](https://www.ycombinator.com/launches/RJj-korso-shepherd-tooling-for-all-your-agents-to-collaborate) (YC), a Go CLI that [runs Claude agents and babysits PRs](https://pkg.go.dev/github.com/JacobRWebb/shepherd) | **high** |
| **tagloop** | A tag starts a loop; "tag" is a near-synonym for label, but also means a git tag, which this project uses for every release | free | **free** (404); 4 repos, top 1 star | none | Myntra's "tagloop" is a physical returns tag; nothing in software | low |
| **ticketloop** | An issue starts a loop; "ticket" fits issues, not PRs | free | **free** (404); 5 repos, 0 stars | none | none found | low |
| **labelrun** | A label starts a run; "run" loses the loop, the review and the fix | free | **free** (404); 3 repos, 0 stars | none | [LabelRun](https://apps.shopify.com/labelrun), a paid Shopify barcode-label app | medium-low |

Also checked and dropped before the shortlist, each for a collision found in the same checks:

- `issueloop`: an active PyPI and npm package for LLM-driven tickets, published August 2026.
- `prloop`: [`dceoy/pr-loop`](https://github.com/dceoy/pr-loop), surveyed above, does nearly this.
- `relayloop`: an npm placeholder about "humans and agents", July 2026.
- `ratchet`: [`sethvargo/ratchet`](https://github.com/sethvargo/ratchet) pins GitHub Actions workflows.
- `cadence`: a Cadence Design Systems registered mark, and Uber's workflow engine.
- `kiln`: Kiln AI, and marks held by Canva and others.
- `handoff`: heavily used by agent tools, including Marketplace actions.
- `roundhouse`, `loomwork`, `looplabel`, `labelflow`, `agentloop`, `looptag`: taken on npm, near
  an AI or labelling product, or reading as something else (a Rust loop label, an RFID tag).

### 5.5 Recommendation

**Recommended: `labelloop`.** It is the only shortlisted name that meets criterion 1 outright,
saying both halves of what the project does, and it meets the other four. It is free on npm and in
the Marketplace's Actions, and no product in software development or AI uses it. Its one cost is
the GitHub organization name, held by an unrelated fashion-wholesale SaaS; the repository can live
at `jeffwlawson/labelloop` and the package publish unscoped, so the organization is not needed.
Before adopting it, search USPTO and EUIPO for "Labelloop" in class 9 and class 42, since the
fashion SaaS may have filed.

**Runner-up: `tagloop`.** It meets all five criteria, it is free on npm, as a GitHub organization
and in the Marketplace, and nothing in software uses it. It is second because "tag" is ambiguous in
exactly this project, where a tag push is how a release happens.

---

## 6. Follow-ups

To file, citing this document:

- **A migration release to `labelloop`**, carrying:
  - the new package and command names;
  - a move from GitHub Packages to the **public npm registry**, since GitHub Packages needs a token
    to install even a public package, which every human running `init` or `doctor` and every
    service orchestrator hits;
  - the version pins, docs and example callers;
  - `init` and `doctor` moving an adopter's pin to the new path;
  - a check, by experiment rather than assumption, of whether a reusable workflow's `uses:`
    follows GitHub's redirect after a repository rename;
  - the trademark search in §5.5 before the name is committed to.
- Question 2 recommends productising, so there is no follow-up recording what narrowing or stopping
  changes for #386 and #387.
- **A watch item, not an issue:** the two conditions in §4 that would reverse the recommendation.
  Re-check gh-aw's FAQ on subscription tokens and `githubnext/agentics` for a budgeted fix loop
  before the migration release ships.
