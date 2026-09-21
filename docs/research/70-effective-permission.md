# What an effective repository permission would cost, and what it would return

Research for **#70**, under map **#68**, on the evidence in **#35**. Feeds **#73** (detect vs
enforce).

**Investigated 2026-09-20/21 (UTC).** Every `gh` result below was run live against
`api.github.com` from a classic PAT with scopes `gist, read:org, repo, workflow`. Findings are
marked **[observed]** where a call was made and its response is quoted, and
**[documentation-derived]** where they rest on GitHub's OpenAPI description, the GraphQL schema's
own field descriptions, or the Actions reference without a call that exercises the case. No case
here was tested with a real `GITHUB_TOKEN`, because doing so would require adding a step to a
workflow — out of scope for this ticket. Every `GITHUB_TOKEN` claim is therefore marked, and the
one that matters is flagged in §C as the single thing #73 must verify before it relies on it.

Settled elsewhere and not re-derived: the `CommentAuthorAssociation` definitions (#35) and
edit-requires-write-access (#37).

## Primary sources

- REST reference, *Get repository permissions for a user*:
  <https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user>
- REST OpenAPI description (the machine-readable source behind that page), operation
  `repos/get-collaborator-permission-level`:
  <https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/dereferenced/api.github.com.deref.json>
- Permissions required for GitHub Apps, *Repository permissions for "Metadata"*:
  <https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps>
- Workflow syntax, `permissions`:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions>
- GraphQL schema, introspected live via `gh api graphql` (the method #35 used).

---

## A. What the APIs are, and what they return

### A1. `GET /repos/{owner}/{repo}/collaborators/{username}/permission`

**Shape** [observed] — `{ permission, role_name, user: { …, permissions: {admin, maintain, push,
triage, pull}, role_name } }`. Both a top-level `role_name` and a nested `user.role_name`; they
agreed in every response observed.

**`role_name` is authoritative; the legacy `permission` field is lossy.** [documentation-derived,
verbatim from the OpenAPI description of the operation]

> The `permission` attribute provides the legacy base roles of `admin`, `write`, `read`, and
> `none`, where the `maintain` role is mapped to `write` and the `triage` role is mapped to
> `read`. The `role_name` attribute provides the name of the assigned role, including custom
> roles.

So they do not so much *disagree* as answer different questions. Concretely:

| Org role | `permission` | `role_name` |
| --- | --- | --- |
| Admin | `admin` | `admin` |
| Maintain | `write` | `maintain` |
| Write | `write` | `write` |
| Triage | `read` | `triage` |
| Read | `read` | `read` |
| (custom role) | nearest base role | the custom role's own name |

Only `admin`/`maintain` and `role_name: admin` were observed directly; the mapping rows are the
description's own text. **Use `role_name` when you need the role, `permission` when you need the
base level.** For this loop's question — "can this actor push" — `permission ∈ {write, admin}` is
the correct and complete test, and `role_name` is *not*, because a custom role's name is an
arbitrary string with no ordering. That is the opposite of the intuitive reading and is the single
most load-bearing sentence in this section.

**It cannot say *why*.** [documentation-derived, verbatim]

> The calculated permissions are the highest role assigned to the collaborator after considering
> all sources of grants, including: repo, teams, organization, and enterprise. There is presently
> not a way to differentiate between an organization level grant and a repository level grant from
> this endpoint response.

**The public-repo floor is `read`, for everyone.** [observed] On `jeffwlawson/agent-workflows`
(public), for `torvalds`, who is not a collaborator in any sense:

```
HTTP/2.0 200 OK
{"permission":"read", …, "user":{…,"permissions":{"admin":false,"maintain":false,"push":false,
 "triage":false,"pull":true},"role_name":"read"},"role_name":"read"}
```

The same call on `jeffwlawson/dotfiles` (private) for the same user returns `"permission":"none"`.
So on a public repo `read` means "can see it", not "is a Read collaborator" — the endpoint cannot
distinguish an outside Read collaborator from an anonymous internet user. This does **not** break
the gate's use of it (both answers are correctly "cannot push"), but it does mean the endpoint
cannot be repurposed to answer "is this person a collaborator at all."

**It requires push access of the *caller*.** [observed, and **undeclared in the OpenAPI spec**,
which lists only `200` and `404` as responses] On `nodejs/node`, where this PAT has read only:

```
HTTP 403
{"message":"Must have push access to view collaborator permission.",
 "documentation_url":"…#get-repository-permissions-for-a-user","status":"403"}
```

This is the most consequential single observation in the ticket and §C turns on it.

**Layer: REUSABLE.** Any call added here would go in `shared/`.

### A2. GraphQL — `Repository.collaborators(login:)` and `permissionSources`

`Repository.collaborators` takes `login: String` [observed via introspection of `Repository`],
which is what makes a per-author lookup possible without listing the whole collaborator set.

`RepositoryCollaboratorEdge` exposes `permission: RepositoryPermission!` and `permissionSources:
[PermissionSource!]` [observed]. `RepositoryPermission` has six values, with the schema's own
descriptions [observed]: `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE_PLUS`, `TRIAGE`, `READ`. Note there
is **no `NONE`** — absence from the connection *is* the "no access" answer. Note also
`TRIAGE_PLUS`, which the REST enum has no counterpart for; a gate written against the REST
vocabulary and one written against the GraphQL vocabulary are not the same gate.

`PermissionSource` does answer *why* [observed]: `{ organization, permission:
DefaultRepositoryPermissionField!, roleName: String, source: PermissionGranter! }`, where
`PermissionGranter` is a union of `EnterpriseTeam | Organization | Repository | Team`. That union
is exactly the "direct grant / team / org base permission / enterprise" distinction REST says it
cannot give.

**But it is admin-gated.** [observed] Asking for it on my own personal repo:

```
"type":"INSUFFICIENT_SCOPES","message":"… The 'permissionSources' field requires one of the
 following scopes: ['admin:org'], but your token has only been granted the: ['gist','read:org',
 'repo','workflow'] scopes."
```

Three separate errors came back, for `permissionSources`, and for `permission` and `roleName`
*inside* it. The edge's own `permission` field is **not** admin-gated — the identical query with
`permissionSources` removed succeeded on the same token:

```
{"data":{"repository":{"a0":{"totalCount":1,"edges":[{"permission":"ADMIN",
 "node":{"login":"jeffwlawson"}}]}, …}}}
```

**So: the *level* is affordable, the *why* is not.** `admin:org` is an organization-administration
scope with no `GITHUB_TOKEN` equivalent (§C2), so `permissionSources` is out of reach for this
loop entirely, on every repo, under every configuration. Anything #73 designs must work from the
level alone.

`collaborators` also requires push access of the caller [observed] — see §C3 for the error shape.

**Layer: REUSABLE.**

### A3. Something on the node itself — `PullRequestReview.authorCanPushToRepository`

**This exists, and it is the finding that changes the shape of the answer.** [observed via
introspection]

```
PullRequestReview.authorCanPushToRepository: "Indicates whether the author of this review has
push access to the repository."
```

It is on `PullRequestReview` **only**. Introspection of the sibling types [observed]:

| Type | has `authorCanPushToRepository`? |
| --- | --- |
| `PullRequestReview` | **yes** |
| `PullRequestReviewComment` | no — but has `pullRequestReview`, which does |
| `IssueComment` | **no** |
| `Issue` / `PullRequest` | no |

The traversal from a thread comment works and costs nothing extra [observed] — a query over
`reviewThreads { comments { pullRequestReview { authorCanPushToRepository } } }` returned
`rateLimit { cost: 1, nodeCount: 120 }`.

`viewerCanUpdate` / `viewerCannotUpdateReasons` exist on all three types but describe the *token*,
not the author, and are not a substitute.

**It is readable with no push access and no extra scope** [observed] — the entire `nodejs/node`
sample in §B was gathered by a token whose `viewerPermission` on that repo is `READ`, in the same
query where `collaborators` returned `FORBIDDEN`. That makes it strictly cheaper than either §A1
or §A2.

**Layer: REUSABLE** — it would be a field added to the existing `QUERY` in
`shared/pr-feedback.ts`, reaching every adopter with no caller change.

**The hole it leaves is the whole reason this is not simply the answer.** Two of the loop's four
trusted surfaces have no node-level field:

| Surface | read at | node type | field available? |
| --- | --- | --- | --- |
| Review summaries | `shared/pr-feedback.ts:41` | `PullRequestReview` | **yes** |
| Review thread comments | `shared/pr-feedback.ts:46–51` | `PullRequestReviewComment` → `pullRequestReview` | **yes**, via traversal |
| PR conversation comments | `shared/pr-feedback.ts:40` | `IssueComment` | **no** |
| Issue title/body + comments | `shared/common.ts` `fetchTrustedIssue` / `fetchTrustedComments` | `Issue` / `IssueComment` | **no** |

So the cheap field covers `review` and the review half of `fix`, and covers nothing that
`implement` or `implement-prd` reads.

---

## B. The cases that decide whether it is usable

Where a row is [observed], it was seen on a live repository and the repository is named.

| Case | `author_association` | `role_name` / GraphQL `permission` | Can push? | Evidence |
| --- | --- | --- | --- | --- |
| Outside collaborator at **Read** | `COLLABORATOR` | REST `read`/`read`; GQL `READ` | no | [documentation-derived] — the `permission`↔`role_name` mapping table in §A1; not observed, this repo cannot host one (#68) |
| Outside collaborator at **Triage** | `COLLABORATOR` | REST `permission: read`, **`role_name: triage`**; GQL `TRIAGE` | no | [documentation-derived], same source. **The legacy field flattens Triage into `read`** — this is the one place the two fields visibly diverge, and it is the exact role #35 and `docs/ADOPTING.md:857` are about |
| Org member, **no direct grant**, public org repo | `MEMBER` | depends entirely on the org's *base permission*: `read`/`write`/`none` | **varies** | [observed] on `nodejs/node`: `mertcanaltin`, `authorAssociation: MEMBER`, `authorCanPushToRepository: **false**` (PR #64190). **This is #35's gap, witnessed live.** If org base permission is `none` the actor is absent from `collaborators` altogether — `totalCount: 0`, identical to a stranger |
| **Write via a team** | `MEMBER` | `write` — teams are folded into the calculated permission | yes | [documentation-derived]: "the highest role assigned … after considering all sources of grants, including: repo, teams, organization, and enterprise". The *fact* of the team is only in `permissionSources`, which is admin-gated (§A2) |
| `github-actions[bot]` | `NONE` | REST **`permission: none`**, all five `user.permissions` false; GraphQL `collaborators` `totalCount: 0` | — | [observed] on `jeffwlawson/agent-workflows`. **But `authorCanPushToRepository: true`** [observed] on that repo's PR #54 reviews |
| Other app/bot identities | `NONE` | not collaborators | — | [observed] `copilot-pull-request-reviewer` on `nodejs/node` PR #64190: `NONE` / `authorCanPushToRepository: false` |
| No association at all | `NONE` / `CONTRIBUTOR` | public repo: `read`; private: `none`; GQL: absent | no | [observed], `torvalds` against both a public and a private repo |
| Access **revoked** after posting | unchanged in a frozen webhook payload; recomputed live in GraphQL | recomputed live — reads as the *current* permission | no | [documentation-derived / reasoned]. Every permission API answers "now", not "at post time" |

Three consequences worth stating on their own.

1. **`github-actions[bot]` splits the two mechanisms in opposite directions.** A collaborator-based
   gate returns `none` for it and would silently drop the review agent's own findings — breaking
   the review → fix handoff that `shared/common.ts:206–240` deliberately special-cases. A
   node-based gate (`authorCanPushToRepository`) returns `true` for it, and the special case
   becomes unnecessary rather than merely retained. That is a real simplification, and it is only
   available on the two review surfaces.

2. **The gap runs both ways.** [observed] The `nodejs/node` sample turned up all four quadrants in
   25 PRs:

   | | can push | cannot push |
   | --- | --- | --- |
   | `MEMBER` | `legendecas` (#65686) | **`mertcanaltin` (#64190)** |
   | `CONTRIBUTOR` | **`aduh95` (#65686)** | `Cherry` (#64606) |

   The current gate trusts `mertcanaltin` and rejects `aduh95`, and is wrong in both directions on
   a single real repository. #35 establishes the over-approximation; this is the
   under-approximation beside it, and #73 should decide whether a narrower gate that also *widens*
   for `aduh95` is one change or two.

3. **Revocation is fail-closed and retroactive.** A live lookup re-reads a former collaborator's
   old comment as untrusted, which is the safe direction but changes an agent's behaviour on a
   re-run with no new input. Worth naming in #73 rather than discovering.

**Layer: REUSABLE** for every row — these are all properties of what `shared/` reads.

---

## C. What it costs at runtime

### C1. Batching into the existing single GraphQL round trip — **yes, for free**

[observed] Five aliased `collaborators(login:)` selections in one query:

```
rateLimit { cost: 1, limit: 5000, remaining: 4579, nodeCount: 5 }
```

**Cost 1 point, same as the query with none of them.** GraphQL's point cost is driven by
connection sizes, not by alias count, and `first: 1` connections are effectively free. The review
traversal in §A3 over 20 threads was also `cost: 1` at `nodeCount: 120`. So neither option costs N
REST calls, and neither costs a second round trip. `shared/pr-feedback.ts`'s design rationale at
lines 30–35 ("Doing it in a single GraphQL round trip … is what makes `isResolved` available")
survives intact.

The mechanics differ though. `authorCanPushToRepository` is a field on nodes the query already
selects — no author set to collect, no second pass. Aliased `collaborators(login:)` requires the
distinct author logins *before* the query is built, which means either two round trips or a
separate query for the conversation surface. That asymmetry, not the point cost, is the real
argument for the node field where it exists.

**Layer: REUSABLE** — `shared/pr-feedback.ts`, `shared/review-context.ts`, `shared/common.ts`.

### C2. `GITHUB_TOKEN` scopes — **no new `permissions:` line, but a live caveat**

[documentation-derived] `GET /repos/{owner}/{repo}/collaborators/{username}/permission` and `GET
/repos/{owner}/{repo}/collaborators` are both listed under **"Repository permissions for
'Metadata'", read**, on the permissions-required reference — not under Administration. `metadata:
read` is implicit for `GITHUB_TOKEN` and is not settable in a `permissions:` block. So **no
adopter's caller would need a new grant**, which is the difference between a change that lands
wholly in the reusable half and one that needs every adopter to edit their own caller.

[documentation-derived] The `permissions:` block's available keys are `actions,
artifact-metadata, attestations, checks, code-quality, contents, deployments, discussions,
id-token, issues, packages, pages, pull-requests, security-events, statuses, vulnerability-alerts`.
There is **no `administration`, `members` or `organization-administration` key**. This is what
makes `permissionSources` (§A2, needs `admin:org`) permanently unreachable rather than merely
inconvenient — a repository `GITHUB_TOKEN` has no way to ask for it, so **no, nothing here works
via admin, and the part that would need admin simply cannot be had.**

**The caveat, and it is the one thing #73 must verify empirically:** the observed 403 in §A1 says
the caller needs **push access**, which the Metadata-read documentation does not mention. For a
`GITHUB_TOKEN` this most likely reads as `contents: write`. Against the loop's current grants:

| Reusable workflow | `contents:` | collaborator endpoints readable? |
| --- | --- | --- |
| `fix.yml` | `write` | probably yes |
| `implement.yml` | `write` | probably yes |
| `implement-prd.yml` | `write` | probably yes |
| `update-branch.yml` | `write` | probably yes |
| **`review.yml`** | **`read`** | **probably no** |
| **`follow-ups.yml`** | **`read`** | **probably no** |

If that holds, the collaborator route is unavailable to `review` — the workflow whose whole job is
reading other people's text — unless its `contents:` grant is widened from `read` to `write`, which
is a materially worse trade than the gap it closes. **`authorCanPushToRepository` has no such
problem** [observed]: the entire `nodejs/node` sample was read at `viewerPermission: READ`.

This table is the only place in this document where a **[documentation-derived]** inference sits
under a decision. #73 should confirm it with one throwaway workflow step before designing around
it; a single `gh api` call in a `contents: read` job settles it.

**Layer: REUSABLE** for the reading; the `permissions:` conclusion is what keeps it from becoming
an ADOPTER-half change.

### C3. Unreadable vs "not a collaborator" — **distinguishable in GraphQL, dangerously not in REST**

This is the decisive requirement (`CLAUDE.md`, *Changing the install path* §4: an unreadable fact
must stay `undefined` rather than collapsing into a pass).

**REST: the three collapse.** [observed]

| Situation | Response |
| --- | --- |
| Not a collaborator, public repo | **200**, `permission: read` |
| Not a collaborator, private repo | **200**, `permission: none` |
| Username does not exist | **404** |
| Repo not visible to the token | **404** |
| Token lacks push access | **403** `"Must have push access to view collaborator permission."` |

The 403 *is* cleanly distinguishable, and its message is explicit — which is better than expected,
and is **undocumented**: the OpenAPI description declares only `200` and `404` for this operation.
Relying on an undeclared status is a hazard worth naming in whatever #73 writes.

The 404 is the problem: "no such user" and "cannot see this repo" are the same response, and the
second is an unreadable fact that a naive `catch → false` would turn into a confident "untrusted".
That is fail-closed rather than fail-open, so it is not a security hole — but it is exactly the
"one signature, two causes" shape `CLAUDE.md` names under *Conventions*, and it makes a `doctor`
check unable to say which it saw.

**GraphQL: cleanly separable, per author.** [observed] Against `nodejs/node` at read-only:

```
{"data":{"repository":{"viewerPermission":"READ","a0":null,"a1":null}},
 "errors":[{"type":"FORBIDDEN","path":["repository","a0"],
            "message":"You do not have permission to view repository collaborators."}, …]}
```

and against a repo that does not exist:

```
{"data":{"good":{…},"bad":null},
 "errors":[{"type":"NOT_FOUND","path":["bad"], "message":"Could not resolve to a Repository …"}]}
```

Three distinct states, and the distinction is **per alias**:

| Meaning | Shape |
| --- | --- |
| Has access at level X | alias non-null, `totalCount: 1`, `edges[0].permission: X` |
| **Genuinely not a collaborator** | alias non-null, `totalCount: 0`, `edges: []` |
| **Unreadable** | alias **`null`** + an `errors[]` entry whose `path` names that alias, `type` ∈ `FORBIDDEN` / `NOT_FOUND` / `INSUFFICIENT_SCOPES` |

`null` vs `totalCount: 0` is precisely the `undefined` vs `false` distinction `CLAUDE.md` demands,
and one unreadable author does not poison the answers for the others. **Anything #73 builds should
use GraphQL for this reason and not because of the round-trip count.**

One implementation hazard, in the tree today: `gh` exits **non-zero** on a partial-error GraphQL
response even though the JSON on stdout carries the good data [observed — both were present in
every partial-error call above]. `shared/common.ts:146`'s `gh()` throws on non-zero exit, and
`shared/pr-feedback.ts:179` catches it as `catch { pr = undefined }`. So today one `FORBIDDEN`
alias would discard **the entire feedback fetch**, not just that author — every surface empty,
`hasFeedback: false`, the run refuses. Fail-closed, but with no reason written anywhere, which is
the `(no reason file written)` failure mode `CLAUDE.md` names. Adding aliased `collaborators` to
that query without changing the error handling would make a single unreadable author silently
disable the whole workflow.

**Layer: REUSABLE**, all of it.

---

## D. Fork PR author vs same-repo commenter — **no difference, and that is the useful answer**

**Effective permission is a property of the actor against the *base* repository.** Fork ownership
never enters the calculation. The same person commenting on a same-repo PR and authoring a fork PR
gets the identical answer from every API in §A. `author_association`, by contrast, *does* shift —
opening a PR from a fork makes someone `CONTRIBUTOR` who would otherwise be `NONE` — so the
permission APIs are strictly more stable across this axis than the field the gate reads today.

[observed] `aduh95` on `nodejs/node` PR #65686 is `authorAssociation: CONTRIBUTOR` with
`authorCanPushToRepository: true`; `Cherry` on #64606 is `CONTRIBUTOR` with `false`. Same
association, opposite push access, same repo. `CONTRIBUTOR` carries no permission information at
all, in either direction.

`authorCanPushToRepository`'s schema description — "push access to **the repository**" — resolves
against the PR's repository, i.e. the base repo, which the `nodejs/node` sample confirms (node
collaborators `true`, drive-by contributors `false`).

**But the axis that actually bites `implement` is a different one.** `review` and `fix` are
fork-guarded; `implement` reads issues, which anyone can open, and **the entire issue surface has
no node-level field** (§A3). So for `implement` / `implement-prd` the only route is the
collaborator lookup, which means:

- the REST 404 ambiguity (§C3) or a second GraphQL query keyed by the issue author's login, and
- the `contents:`-grant question in §C2 — though both `implement` workflows already hold
  `contents: write`, so if push access is the real requirement they are the two workflows for
  which it is already satisfied.

**Layer: REUSABLE** — `shared/common.ts`'s `fetchTrustedIssue` / `fetchTrustedComments`.

---

## What this means for #73 (detect vs enforce)

Six things, in the order they constrain the decision.

1. **There is no single mechanism.** `authorCanPushToRepository` is free, unprivileged and exact,
   and covers only review summaries and review-thread comments. PR conversation comments and the
   whole issue surface have nothing equivalent and need a collaborator lookup. **#73 cannot pick
   one and must decide whether a two-mechanism gate is acceptable or whether the uniform-but-worse
   collaborator lookup should be used everywhere for consistency.** That is the real fork in the
   road and it is not a cost question.

2. **Enforcing is affordable.** One GraphQL point, no extra round trip, no new `permissions:`
   grant in any adopter's caller. The "we cannot afford it" argument for staying with
   `author_association` does not survive this ticket. The remaining arguments against enforcing are
   about migration and blast radius, not cost.

3. **`review` and `follow-ups` may be unable to do the collaborator lookup at all** — they hold
   `contents: read`, and the endpoint's observed 403 demands push access (§C2). Verify this with
   one throwaway step before designing; it is the difference between "enforce everywhere" and
   "enforce where the node field exists, detect elsewhere". Note that the node field is available
   in exactly the workflow that would otherwise be blocked, which is a convenient accident rather
   than a design.

4. **Detect is well served and enforce is well served; the middle is not.** GraphQL's `null` +
   `errors[].path` gives a per-author three-state answer that satisfies `CLAUDE.md`'s `undefined`
   rule exactly, so a `doctor`-style report can honestly say "I could not tell" for one author
   while ruling on the rest. REST's 404 cannot, and a `catch → false` on either would violate that
   rule in spirit even while failing closed.

5. **Whatever #73 chooses, `shared/pr-feedback.ts`'s error handling has to change first.** Today a
   single `FORBIDDEN` alias would discard the whole feedback fetch and refuse with no reason
   written (§C3). That is a prerequisite, not a detail, and it is a defect that exists today
   independent of this decision — worth its own issue.

6. **The gap is bidirectional and the map does not yet say so.** #35 charts `MEMBER`/`COLLABORATOR`
   trusted without write. The same live sample shows `CONTRIBUTOR` *with* write being rejected
   (§B.2). A narrowing change and a widening change are being considered as one, and #73 should say
   out loud whether it intends both.

**Layer, overall: REUSABLE.** Every finding lands in `shared/` and reaches every adopter from a
release. Nothing here requires an adopter to touch their caller — specifically because the
endpoints sit under `metadata: read` and not under an `administration` scope that `GITHUB_TOKEN`
has no key for. That is the load-bearing reason this effort's *input-gate* half stays on the
reusable side of the seam #68 draws, and it says nothing about the *trigger* half at
`docs/ADOPTING.md:864`, which remains the adopter's.
