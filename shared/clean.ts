/**
 * Cleanup of free text read from a hand-over (ADR 0005, ADR 0007): the one
 * function every piece of it passes through, whoever wrote it. The agent's
 * words, a maintainer's reply the agent quotes and red-check output all sit in
 * files the agent's runner can write, so all of them are cleaned the same way,
 * when a command reads them, and before the loop adds a string of its own.
 *
 * What it removes is #391's to strengthen. The floor is every HTML comment,
 * which is every marker the loop writes: text with none in it can neither
 * forge a marker nor hide an instruction from the human reading the record.
 *
 * No imports, so a formatter can name the type without loading the reader.
 */

/**
 * Text that has been through `clean`. A formatter takes this, not `string`,
 * so a write built from unread text fails typechecking.
 */
export type Cleaned = string & { readonly __cleaned: unique symbol };

/**
 * An HTML comment, through its close or, unclosed, through the end of the
 * text, since that is how far a renderer hides it. It ends at the first
 * `-->`, which may be later than where a parser ends it (`<!-->`, `--!>`):
 * removing more than the comment is safe, and removing less is not.
 */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * `text` with every HTML comment removed. Repeated until none is left, so a
 * comment split around another (`<!<!-- -->-- ... -->`) does not survive as
 * the join of the halves: what comes out holds no `<!--` at all.
 */
export const clean = (text: string): Cleaned => {
  let cleaned = text;
  for (let previous = ""; previous !== cleaned; ) {
    previous = cleaned;
    cleaned = cleaned.replace(COMMENT, "");
  }
  return cleaned as Cleaned;
};
