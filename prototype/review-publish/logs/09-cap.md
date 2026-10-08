# 09-cap

| # | token | write | target | outcome | calls |
|---|---|---|---|---|---|
| 1 | publish/workflow | removeLabel | `#7 agent:blocked` | **applied** | DELETE label ok |
| 2 | publish/workflow | replyAndResolve | `T1 ADDRESSED` | **applied** | reply ok; resolve ok |
| 3 | publish/workflow | replyAndResolve | `T2 ADDRESSED` | **refused** | cap of 1 replyAndResolve reached |
| 4 | conclude/workflow | commitStatus | `aaaaaaa agent-review=error` | **applied** | POST status ok |
| 5 | conclude/workflow | comment | `#7` | **applied** | POST comment ok |
| 6 | conclude/workflow | removeLabel | `#7 agent:review` | **applied** | DELETE label ok |
| 7 | conclude/workflow | addLabel | `#7 agent:blocked` | **applied** | POST labels ok |

publish: **failure** (Error: replyAndResolve past its cap of 1, at T2 ADDRESSED)

conclude: **success**

ended: `{"moved":false}`

labels after: `agent:blocked`