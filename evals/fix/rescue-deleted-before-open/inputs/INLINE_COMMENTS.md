**implement/publish.ts:104** · thread `PRRT_eval_rescue_deleted_before_open`

@jeffwlawson-agent-loop[bot]:
Medium

`deleteRescue` runs right after the push and before `openPullRequest`. If opening the PR then throws, `published.json` says `pushed: true` with no `pr`, so conclude rescues nothing and posts the plain retry. On that retry, prepare cuts `BRANCH` fresh at the base with no rescue left to resume from, and publish's push, leased on the tip the gate read, replaces the earlier branch. The rescued commits and everything built on them are lost. Move the deletion to after `state.pr = pr; record();`, and update the publish test's order and the publish order in `docs/platform-spec.md` to match.

<!-- agent-finding f-f63badd1 medium title:UmVzY3VlIGlzIGRlbGV0ZWQgYmVmb3JlIHRoZSBQUiBvcGVucywgc28gYSBmYWlsZWQgb3BlbiBsb3NlcyBpdA== -->
