# 06-head-moved

| # | token | write | target | outcome | calls |
|---|---|---|---|---|---|
| 1 | publish/workflow | removeLabel | `#7 agent:blocked` | **applied** | DELETE label ok |
| 2 | publish/workflow | replyAndResolve | `T1 ADDRESSED` | **applied** | reply ok; resolve ok |
| 3 | publish/workflow | replyAndResolve | `T2 ADDRESSED` | **applied** | reply ok; resolve ok |
| 4 | publish/workflow | postReview | `PR_node` | **applied** | addPullRequestReview ok |
| 5 | publish/workflow | editPullRequest | `#7 title body` | **applied** | GET pull ok; PATCH title+body ok |
| 6 | publish/workflow | editPullRequest | `#7 body` | **applied** | GET pull ok; PATCH body ok |
| 7 | publish/workflow | addLabel | `#7 agent:follow-ups` | **applied** | POST labels ok |
| 8 | publish/workflow | commitStatus | `aaaaaaa agent-review=failure` | **applied** | POST status ok |
| 9 | publish/workflow | commitStatus | `aaaaaaa agent-fix-round=success` | **applied** | POST status ok |
| 10 | conclude/workflow | removeLabel | `#7 agent:review` | **applied** | DELETE label ok |
| 11 | conclude/loop | addLabel | `#7 agent:review` | **applied** | POST labels ok |

publish: **success**

conclude: **success**

ended: `{"moved":true,"reviewUrl":"https://github.com/o/r/pull/7#pullrequestreview-1"}`

labels after: `agent:follow-ups, agent:review`