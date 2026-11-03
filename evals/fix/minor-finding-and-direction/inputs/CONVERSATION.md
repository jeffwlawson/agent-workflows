**@jeffwlawson** · comment `IC_kwDOTzVKqM8AAAABicpGXw`
## The controls have now been run, and they are not reliable yet

The README says no run of the controls had been made. I ran them on this head (`a00633d`), twice, with two echo models. Total spend $1.51.

| Run | Review rulings as expected | Fix rulings as expected | Broken rulings |
| --- | --- | --- | --- |
| `--model claude-haiku-5-5` ($0.07) | 25 of 27 | 4 of 6 | review `clean` 01 (approved-at-head), review `restart` 04 (changes-after-fix), fix `shipped-fix` 02 and 03 |
| `--model claude-opus-5-5` ($1.44) | 23 of 27 | **6 of 6** | review `persisted` 01, 02, 03 (merge-check-at-head), review `restart` 04 (changes-after-fix) |

**Reading.** The two runs break different controls, so most of the "broken" rulings are the echo, not the graders: the model asked to repeat 100 to 250 lines of text back as its final message does not always do it, and the graders then judge what it wrote. The fix controls pass 6 of 6 once the echo model is stronger. One failure repeats under both models, `restart-order/changes-after-fix` grader 04 (`expect: pass`, a "Changes recommended" review that the grader says does not ask for a change); that one needs looking at as a real grader or control problem.

### Please change

1. **Make a control's verdict depend on the text, not on the echo.** Prefer grading the control's text directly with no model in between (for example, a staged case whose only step is to print the file with a command and whose graders read that). If the tool cannot, then record the echoed final message, compare it with the control's text, and report a control whose echo differs as **void: echo differs**, not **broken**; the report counts voids separately and the command exits 1 only on a ruling that differs while the echo matched.
2. **Look at `restart-order/changes-after-fix` grader 04.** The control text is the loop's Review 3 at `58a8c32` of #577 (asked for changes). If the grader fails it for a real reason, fix the grader; if the control's text or `expect` is wrong, fix the control; say which in the pull request.
3. **Replace the README sentence** "No run of the controls had been made when they were added" with the actual result once you have a way to produce one, or with what to expect (a table is mine to post after you push).
4. Keep everything else. The loop's review is clean; this is only about making the controls trustworthy.

You cannot run the controls (no credential in the loop); I will run them on your push and post the result here.
