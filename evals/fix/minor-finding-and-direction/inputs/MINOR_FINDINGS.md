## `fu-0b4e2f81` · low · `scripts/eval-prompts.ts:1009`

**Waiver accepted from any comment, not only the body**

`if (texts.some((text) => WAIVER.test(text))) return [];` reads the waiver from every text it is given. `checkComparison` passes it the body and all issue comments, but `evals/README.md:302` says the waiver goes "in the body". Anyone who can comment can post `Eval-Waiver: x`, and the next run after a push or body edit passes a prompt change with no comparison, without saying where the waiver came from. Read the waiver from the body (the first text) only:

```suggestion
  if (WAIVER.test(texts[0] ?? "")) return [];
```
