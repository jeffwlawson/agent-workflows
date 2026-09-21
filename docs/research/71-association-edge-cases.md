# `author_association` in the adopter edge cases, and its stability over time

Research for [#71](https://github.com/jeffwlawson/agent-workflows/issues/71), under map
[#68](https://github.com/jeffwlawson/agent-workflows/issues/68), evidence
[#35](https://github.com/jeffwlawson/agent-workflows/issues/35). Investigated 2026-09-20.

**Bottom line.** The field is **recomputed at read time** — established by observation, not
inference, on three independent public repositories. The gate at `shared/common.ts:240` therefore
does not read a fact about the comment; it reads a fact about *today's* access, attached to a body
written at some other time. Both hazards #71 names are real, but they are the *same* hazard: the
value has no relationship to the access its author held when they wrote the text.

## How to read the evidence markers

Every finding below carries one of:

- **Observed** — reproduced against the live GitHub API in this session, with the command shown.
- **Documentation-derived** — taken from GitHub's own reference material, not reproduced. No
  organization is reachable from this session's token (`gh api user/orgs` returns empty; scopes
  `gist, read:org, repo, workflow`), so nothing requiring a permission grant on an org repo could
  be exercised. Permission levels are not public data, so even reading a third party's org repo
  cannot confirm what role an author holds.

And a **layer**: **REUSABLE** (`shared/`, reaches every adopter on upgrade) or **ADOPTER**
(their caller, their org settings, their checkout — this repo cannot reach it).

---

## A. The over-approximation, case by case

The enum definitions are settled in [#35](https://github.com/jeffwlawson/agent-workflows/issues/35)
and are not re-derived here. Two values #35 did not record are load-bearing for §B, so they are
quoted from the same introspection surface
([GraphQL `CommentAuthorAssociation`](https://docs.github.com/en/graphql/reference/enums#commentauthorassociation)):

```
CONTRIBUTOR            :: Author has previously committed to the repository.
FIRST_TIME_CONTRIBUTOR :: Author has not previously committed to the repository.
```

Both are defined by *history*, and both are relative to a moment that the definition does not name.
That omission is the crack §B opens.

| Case | Reported association | Passes `isTrustedAuthor`? | Can push? | Evidence |
| --- | --- | --- | --- | --- |
| Outside collaborator at **Read** | `COLLABORATOR` | **yes** | **no** | documentation-derived |
| Outside collaborator at **Triage** | `COLLABORATOR` | **yes** | **no** | documentation-derived |
| Org member, **no grant** on the repo | `MEMBER` | **yes** | **no** | documentation-derived |
| Org member, **Write via a team** | `MEMBER` (not `COLLABORATOR`) | yes | yes | **observed** |
| **Former** collaborator/member, access revoked | `CONTRIBUTOR` or `NONE` | **no** | no | **observed** |

### A.1 Read and Triage clear the gate — documentation-derived — REUSABLE

[Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
describes **Triage** as "for contributors who need to proactively manage issues, discussions, and
pull requests **without write access**", and neither Read nor Triage carries the table's
push-to-repository permission. The enum's `COLLABORATOR` is "Author has been invited to collaborate
on the repository" — invitation, with no role named. So a Read collaborator's issue body is trusted
input to `implement`, and their PR comment is trusted input to `fix`, which pushes.

This confirms #35's claim rather than extending it. It remains **documentation-derived**: no org
repo was available to write a Read-collaborator comment on and read the value back. What *is*
observed is the weaker half — that `COLLABORATOR` is emitted at all, and that it is emitted without
any accompanying permission field.

### A.2 `MEMBER` outranks `COLLABORATOR` — observed — REUSABLE

On `nodejs/node` (an org repo whose write-holders are org members with team-granted access), every
such author reports `MEMBER`, never `COLLABORATOR`:

```bash
gh api repos/nodejs/node/pulls/40596/reviews --jq '.[] | "\(.user.login) \(.author_association)"'
# jasnell MEMBER    targos MEMBER    Trott MEMBER    richardlau MEMBER
# cjihrig CONTRIBUTOR    Linkgoron CONTRIBUTOR
```

So the value is a **single winner from a precedence order**, not a set. Practical consequence for
any successor design: you cannot recover "is an outside collaborator" from the field, because org
membership masks it. `MEMBER` tells you nothing about repository access in either direction — it
does not imply a grant, and it does not rule one out.

The mask also means the org-member-with-no-grant case is **unobservable from outside**: `MEMBER`
appears identically whether the author has Admin or nothing. That is itself the finding — the
field cannot distinguish the cases the gate needs distinguished.

### A.3 Org base permission defaults to Read, and can be none — documentation-derived — ADOPTER

[Setting base permissions](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/setting-base-permissions-for-an-organization):
"By default, members of an organization will have **Read** permissions to the organization's public
repositories", and the page's own note confirms **none** is a settable value ("even if the base
permission has been set to none"). So the default configuration of an adopting organization puts
*every* member at Read on the repo running this loop — passing the gate, unable to push. This is
not an exotic misconfiguration; it is the out-of-the-box state.

Which base permission an org runs is the **adopter's** to know. That it is invisible to `shared/`
is the reusable half's problem.

### A.4 Revoked access — observed — REUSABLE

See §B.2; the revocation case is the same observation as the read-time one.

---

## B. Read time or write time? **Read time.** Observed.

Three independent observations, in both directions, on three repositories. GitHub publishes no
statement either way (§D), so this is established empirically.

### B.1 The grant direction — observed

`jakebailey` joined the TypeScript team in 2022. Items he authored in `microsoft/TypeScript`
*before* that now report `MEMBER`:

```bash
gh api -X GET search/issues -f q='repo:microsoft/TypeScript author:jakebailey type:issue' \
  -f sort=created -f order=asc --jq '.items[] | "\(.number) \(.created_at) \(.author_association)"'
# 40713 2020-09-23T00:22:20Z MEMBER
# 45591 2021-08-26T22:33:16Z MEMBER
```

Same shape for `targos` on `nodejs/node`: PRs from **February 2015**, predating his collaborator
status, report `MEMBER` today.

### B.2 The revocation direction — observed — and the clean control

`Fishrock123` was a Node.js core collaborator and TSC member for years and is no longer. *Every*
item he authored — including ones written squarely inside that period — now reports `CONTRIBUTOR`:

```bash
gh api -X GET search/issues -f q='repo:nodejs/node author:Fishrock123 type:pr' \
  -f sort=created -f order=desc --jq '.items[] | "\(.number) \(.created_at) \(.author_association)"'
# 40596 2021-10-25T17:22:57Z CONTRIBUTOR
# 36008 2020-11-06T21:10:07Z CONTRIBUTOR
```

The control is what makes this decisive rather than suggestive. On **one thread**, `nodejs/node`
#40596, two authors commented **97 minutes apart on 2021-10-25**, both org members at the time:

```bash
gh api repos/nodejs/node/issues/40596/comments --jq '.[] | "\(.user.login) \(.author_association)"'
# Trott         MEMBER        <- still a member
# Fishrock123   CONTRIBUTOR   <- no longer a member
```

Same repository, same thread, same afternoon. The values differ. Nothing about the comments changed;
only the authors' present status did. A write-time-frozen field cannot produce this.

### B.3 The independent confirmation: `FIRST_TIME_CONTRIBUTOR` decays — observed

`FIRST_TIME_CONTRIBUTOR` is *defined* as "has not previously committed to the repository", so a
frozen field would leave every contributor's first PR marked that way forever. It does not:
`Andarist`'s first PR to `microsoft/TypeScript`, #24244 from May 2018, reports `CONTRIBUTOR` today.

This matters beyond confirming §B.1/B.2: it shows the recomputation is not a special case for
membership but the field's general behaviour, so a successor policy cannot assume some values are
stable and others are not.

### B.4 What this actually means for the gate — REUSABLE

The consequence is sharper than "one of two hazards". Because the field is recomputed, it carries
**no information at all about the access its author held when they wrote the body**:

- **Grant is retroactive.** A body correctly filtered last month becomes trusted input this month
  with no edit, no event, no webhook and nothing in the audit trail of the issue. `implement`
  re-reads the issue body on every run (`shared/common.ts:275`); a re-run after a grant feeds text
  that was written by, and only ever reviewed as, an untrusted stranger. The
  `lastEditedAt`-style defences #35 records are blind to this — the comment genuinely was not
  edited.
- **Revocation is retroactive too, and in the safe direction only by luck.** A removed
  collaborator's old instructions stop being trusted, which is the behaviour you want. But the
  same mechanism means an *intentionally* trusted record — a maintainer's steering comment on a
  long-lived issue — silently stops being read the day they leave the org, with no error and no
  log line. Nothing in `shared/` distinguishes "dropped because untrusted" from "there were no
  comments".
- **There is no "as of" to pin to.** Any successor that wants write-time semantics must record
  them itself at observation time; GitHub does not retain them on these endpoints. The only
  write-time-frozen copy of the value is the **webhook payload**, which the caller receives and
  which this repo's runners do not read — a fact worth carrying into #73, because it means
  write-time semantics are *available*, but only in the **ADOPTER's** half.

### B.5 What would falsify this

Stated because "unknown is not actionable" cuts both ways. This would be overturned by a single
counter-example: an item whose reported association is impossible under present access — e.g. a
`MEMBER` from an author verifiably not in the owning org today. None was found; the §B.2 control
rules out the frozen model on its own.

---

## C. REST vs GraphQL: values agree exactly; only the login diverges — observed — REUSABLE

The divergence `shared/common.ts:219-223` documents is real and is **confined to the login**. The
association does not diverge. Same objects, matched by `databaseId`/`id`:

| Object | REST `author_association` | GraphQL `authorAssociation` |
| --- | --- | --- |
| comment `951164276` | `CONTRIBUTOR` | `CONTRIBUTOR` |
| comment `951185046` (Trott) | `MEMBER` | `MEMBER` |
| comment `951259546` (Fishrock123) | `CONTRIBUTOR` | `CONTRIBUTOR` |
| review `788414595` (jasnell) | `MEMBER` | `MEMBER` |
| review `788416294` (targos) | `MEMBER` | `MEMBER` |

```bash
gh api repos/nodejs/node/issues/40596/comments --jq '.[] | "\(.id) \(.user.login) \(.author_association)"'
gh api graphql -f query='{ repository(owner:"nodejs",name:"node"){ issueOrPullRequest(number:40596){
  ... on PullRequest { comments(first:10){ nodes { databaseId authorAssociation author { login __typename } } }
                       reviews(first:5){ nodes { databaseId authorAssociation author { login } } } } } } }'
```

The same call also re-confirms the login divergence the bot branch exists for: REST
`github-actions[bot]`, GraphQL `github-actions`, same account, same comments. So
`shared/common.ts:275,302` (REST) and `shared/pr-feedback.ts:137` (GraphQL) can share one
association predicate safely — they already do, and that is correct.

### C.1 An incidental finding, and it is not cosmetic — observed — REUSABLE

The doc comment at `shared/common.ts:207-209` says the workflow bot's `author_association` is
`NONE`. On `nodejs/node` it is **`CONTRIBUTOR`**, on both APIs — because `CONTRIBUTOR` means "has
previously committed to the repository" and in that repo the bot has. So the bot's association is
**repository-dependent**, and the stated reason for the login branch ("an association-only gate
would discard the review agent's own findings") holds in some repos and not others.

The branch is still right — it must not depend on which repo it runs in — but the comment states
as a fact something that is only sometimes true, and an adopter reading it would conclude the
bot is always filtered by association. Correcting that comment is a **REUSABLE** change and is
adjacent to, but not part of, #69's four statements.

---

## D. Does GitHub anywhere claim association implies write access? **No.** — documentation-derived

Searched: the REST reference for
[issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28),
[pulls](https://docs.github.com/en/rest/pulls/pulls) and
[commit comments](https://docs.github.com/en/rest/commits/comments); the
[GraphQL enum reference](https://docs.github.com/en/graphql/reference/enums#commentauthorassociation);
[webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads);
the [Actions contexts reference](https://docs.github.com/en/actions/learn-github-actions/contexts);
and GitHub's published OpenAPI description
(`github/rest-api-description`, `descriptions/api.github.com/dereferenced/api.github.com.deref.json`).

Findings:

1. **The only description GitHub attaches to the field is:** "How the author is associated with the
   repository." The field name occurs 756 times in the dereferenced OpenAPI document and that
   exact sentence 306 times; no other descriptive text for it was found. No permission is named,
   and nothing says when the value is computed.
2. **The REST reference pages carry no prose at all** — `author_association` appears only as an
   enum in the response schema.
3. **The GraphQL schema description is equally silent**: "Author's association with the subject of
   the comment."
4. **No GitHub documentation page recommends `author_association` as an access check**, and none
   offers the `["OWNER","MEMBER","COLLABORATOR"]` triple. GitHub's own guidance on restricting who
   can trigger or influence workflows goes through Actions settings and permissions, not through
   this field.

**So the belief was not inherited from GitHub.** It is a community pattern — the triple is
widespread in third-party workflows — adopted here without a primary source. That is a stronger
correction than "GitHub's docs are misleading": there is nothing to blame, and #69's text should
say the gate's own comment asserted it, not that GitHub did.

One nuance worth not overclaiming: absence of a claim is not a claim of the opposite. GitHub also
never documents the recomputation established in §B. Anything built on the field is built on
observed behaviour with no compatibility promise — which is itself an argument for §"What this
means" below.

---

## Layer summary

| Finding | Layer |
| --- | --- |
| A.1 Read/Triage collaborators pass the gate | REUSABLE — `isTrustedAuthor`, `shared/common.ts:240` |
| A.2 `MEMBER` masks `COLLABORATOR`; field cannot express a role | REUSABLE |
| A.3 Default org base permission is Read; `none` is settable | ADOPTER — org settings, invisible to `shared/` |
| B Recomputed at read time, both directions | REUSABLE — every `shared/` read is affected |
| B.4 Write-time value survives only in the webhook payload | ADOPTER — the caller receives it; no runner reads it |
| C REST and GraphQL agree on the value | REUSABLE — one predicate is safe for both paths |
| C.1 Bot association is repo-dependent, not `NONE` | REUSABLE — doc comment at `shared/common.ts:207-209` |
| D No GitHub source for the belief | REUSABLE — wording of the #69 correction |

---

## What this means for #73 (detect vs enforce)

1. **"Frozen vs live" is off the table as a reason to keep the field.** It is live. Neither the
   gate nor any successor can treat a recorded association as evidence about the moment the text
   was written, and a design that caches one is inventing a guarantee GitHub does not give.

2. **An effective-permission check is strictly better on both axes, not just the safety one.**
   `GET /repos/{owner}/{repo}/collaborators/{username}/permission` answers the question the gate is
   actually asking, and answers it at the same moment — read-time, exactly like the field, so
   nothing is lost on the staleness axis either. The trade #73 weighs is therefore cost (an extra
   API call per author, #72's subject) against correctness, with no residual semantic advantage on
   the association side.

3. **Enforcing in `shared/` fixes A.1 and A.2 for every adopter at once, and it is the only half
   that can.** A.3 — what base permission the org runs — is unknowable from `shared/`, which is
   precisely why `shared/` must stop inferring it. Conversely the *trigger* gap
   (`docs/ADOPTING.md:857`) is unreachable from here and stays the adopter's caller `if:`; §B says
   nothing that changes that split.

4. **Detect-only is weaker here than it looks, because there is no event to detect on.** A
   `doctor` check can enumerate today's Read and Triage collaborators and warn. It cannot see the
   retroactive re-labelling in §B.4 — a grant made after `doctor` ran silently promotes historical
   bodies, and `doctor` is not re-run on a permission change. Detect-only leaves a gap that is
   invisible by construction, and should not be framed as a lighter version of the same protection.

5. **If #73 lands on detect-only anyway, B.4's second bullet is the thing to carry.** The
   *silent-drop* direction — a departed maintainer's steering comments quietly ceasing to be read —
   produces no error and no log line today. That is cheap to fix in `shared/` regardless of which
   way the main decision goes, and it is the kind of silent failure `doctor` exists to remove.
