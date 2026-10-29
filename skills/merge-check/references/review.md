# The orchestrator's review

The loop has already reviewed the PR. Your review exists for what it cannot see: the real environment, text elsewhere that the change made false, and a brief that the world moved under.

## Read everything first

- The issue's **latest Agent Brief** comment. It replaces the body's criteria; the body is context.
- The **full diff**, against `git merge-base HEAD origin/main` (environment.md).
- **Every agent review and every fix commit**, so you know what was found, what was declined and why.
- The verify output **you** ran on the head SHA.

## Axis 1: spec

Every acceptance criterion in the brief gets a verdict: met, unmet, or met wrongly. Then the other direction: anything built that was not asked for.

**A brief written before later work landed.** Compare the brief's date with what merged since (`git log --since=<brief date> origin/main`). Work that landed after the brief can leave a gap the brief never covered: one sandbox brief predated a second sandbox the same code built. Such a gap becomes a new issue rather than scope creep, and the PR's docs must say truthfully what it does not cover.

**What a message newly reaches.** When the change lets text travel somewhere new (a log line now quoted in a PR comment, an error now posted publicly), ask what that text can carry. A refusal echoing a proxy URL was harmless in a log and a password leak once a later change quoted it on a PR. Found before building, it belongs in the brief as a criterion; found after, it is a finding.

## Axis 2: standards

Does the change follow `CLAUDE.md`? Look hardest for **stale text**: comments, `CONTEXT.md`, docs and prompts the change made false elsewhere. Every real standards finding across past runs was one.

The sweep is yours, on the head's whole tree. For each behaviour the PR changes, write down the phrases that described the old behaviour ("shares the host's network", "its scheme carries through"), grep the whole checkout for each, and read every hit. A list of places someone else handed you, the loop's review included, is where the sweep starts. Done when every hit is either still true or in a finding.

## Real-environment probes

The loop's CI runs where it runs; some checks need a real host. Two sources say which:

- **Tests the loop's review says it skipped**, usually for a missing tool. Install the tool and run them.
- **The brief's *After merge, by a human* items**, and any check a criterion names that CI cannot run. Run each one you can before the merge rather than after.

Then probe what the change claims to prevent, by trying to make it happen. For a boundary (a sandbox, a permission, an allowlist), try every route past it, not only the one the tests cover. In agent-workflows, for example, the loop's reviewer had no `bwrap`, so the sandbox tests were skipped; the probe was to install it and try every way out of the sandbox's network: the host's loopback and the proxy's own port, the host's real address, IPv6, outside and private ranges. A trap from that run: a synchronous spawn blocked an in-process host end's event loop and looked like a hang.

Each probe ends run, with what it showed, or named as one you could not run here, with why.

## Writing findings

Each finding: the file and line, what is wrong, and the rule that fixes it. For a fix round, add "change nothing else": a fix round reads a maintainer comment literally. A finding you argue away instead goes in a PR comment saying why, so the record shows it was weighed.

Collect the brief's *After merge, by a human* items as you go; they go in the final report.
