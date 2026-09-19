# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

**Layout: single-context.** One `CONTEXT.md` at the repo root, with `docs/adr/` alongside it for
decisions. There is no `CONTEXT-MAP.md` and no per-package context — this is a single npm package.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root. It is the domain model: the three layers, what belongs in each,
  and the vocabulary below.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest
creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

`docs/adr/` does not exist yet. That is the expected state — the first ADR creates it.

## Where the decisions currently live

This repo predates `docs/adr/`, and a large amount of settled reasoning is already written down
outside it. Read these before proposing that something is undecided:

- **`CLAUDE.md`** — commands, conventions, and the release mechanics. The *"This repo runs its own
  loop, on the last release"* section is a decision record in all but name.
- **`docs/parity.md`** — the numbered analysis of what the loop does and does not do. §10
  (*Invariants*) is the closest thing here to a set of ADRs, and several rules record that they
  have been re-derived and re-argued before.
- **`docs/ADOPTING.md`** — decisions expressed as instructions to an adopter.
- **`docs/friction.md`** — a dated narrative log of what went wrong. **Append; never rewrite an
  entry to match today.**
- **`docs/agents/ticket-shape.md`** — the one file in `docs/agents/` that is loop doctrine rather
  than generated configuration, and is never regenerated.

A new ADR under `docs/adr/` is the right home for a *new* decision. Don't migrate the existing
prose into one; a decision written in two places is a decision that can disagree with itself.

## File structure

```
/
├── CONTEXT.md
├── CLAUDE.md
├── docs/
│   ├── adr/            ← created lazily by /domain-modeling
│   ├── ADOPTING.md
│   ├── parity.md
│   ├── friction.md
│   └── agents/         ← this directory
└── <runner>/           ← implement/, review/, fix/, update-branch/, implement-prd/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a
test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary
explicitly avoids.

In particular, `CONTEXT.md`'s *three layers* distinction — **caller**, **reusable workflow**,
**runner** — decides where a change belongs, and the layer names are the vocabulary. "The workflow"
is ambiguous between two of them; say which.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## One vocabulary rule that runs the other way

**Prompts name no domain.** A runner's `prompt.md` must not use any consuming repo's vocabulary,
and must never name the gate command directly — say "the verify command `CLAUDE.md` names". A test
enforces both over the runner surface.

So the glossary rule above applies to *your* output — issues, proposals, tests, commit messages —
and stops at the prompt files, where the constraint is the opposite one.

## Flag ADR conflicts

If your output contradicts an existing ADR — or one of the invariants in `docs/parity.md` §10 —
surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
