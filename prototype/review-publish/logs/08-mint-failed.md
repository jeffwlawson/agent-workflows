# 08-mint-failed

| # | token | write | target | outcome | calls |
|---|---|---|---|---|---|
| 1 | conclude/workflow | commitStatus | `aaaaaaa agent-review=error` | **applied** | POST status ok |
| 2 | conclude/workflow | comment | `#7` | **applied** | POST comment ok |
| 3 | conclude/workflow | removeLabel | `#7 agent:review` | **applied** | DELETE label ok |
| 4 | conclude/workflow | addLabel | `#7 agent:blocked` | **applied** | POST labels ok |

publish: **skipped**

conclude: **success**

ended: `{"moved":false}`

labels after: `agent:blocked`