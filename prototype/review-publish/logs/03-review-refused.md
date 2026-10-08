# 03-review-refused

| # | token | write | target | outcome | calls |
|---|---|---|---|---|---|
| 1 | publish/workflow | removeLabel | `#7 agent:blocked` | **applied** | DELETE label ok |
| 2 | publish/workflow | replyAndResolve | `T1 ADDRESSED` | **applied** | reply ok; resolve ok |
| 3 | publish/workflow | replyAndResolve | `T2 ADDRESSED` | **applied** | reply ok; resolve ok |
| 4 | publish/workflow | postReview | `PR_node` | **failed** | addPullRequestReview graphql addPullRequestReview: 422 refused by the fake |
| 5 | conclude/workflow | commitStatus | `aaaaaaa agent-review=error` | **applied** | POST status ok |
| 6 | conclude/workflow | comment | `#7` | **applied** | POST comment ok |
| 7 | conclude/workflow | removeLabel | `#7 agent:review` | **applied** | DELETE label ok |
| 8 | conclude/workflow | addLabel | `#7 agent:blocked` | **applied** | POST labels ok |

publish: **failure** (Error: GitHub refused the review, so it was not posted. Its threads are not on the pull request and there is no verdict; the earlier threads this review closed were resolved where GitHub allowed it, and the write log names any that were not.)

conclude: **success**

ended: `{"moved":false}`

labels after: `agent:blocked`