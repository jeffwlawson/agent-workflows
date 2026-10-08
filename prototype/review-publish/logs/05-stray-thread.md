# 05-stray-thread

| # | token | write | target | outcome | calls |
|---|---|---|---|---|---|
| 1 | publish/workflow | removeLabel | `#7 agent:blocked` | **applied** | DELETE label ok |
| 2 | conclude/workflow | commitStatus | `aaaaaaa agent-review=error` | **applied** | POST status ok |
| 3 | conclude/workflow | comment | `#7` | **applied** | POST comment ok |
| 4 | conclude/workflow | removeLabel | `#7 agent:review` | **applied** | DELETE label ok |
| 5 | conclude/workflow | addLabel | `#7 agent:blocked` | **applied** | POST labels ok |

publish: **failure** (Error: The review closed threads that are not on PR #7: T-elsewhere)

conclude: **success**

ended: `{"moved":false}`

labels after: `agent:blocked`