/**
 * The XML the red check reads (#422): a JUnit report, which is the PR's to
 * write, so it is parsed strictly, and a document that is not well-formed is
 * refused, never read as far as it goes. What it keeps is what the classifier
 * reads: each element's name, its attributes, the text before its first child,
 * and its children. Comments, processing instructions and a document type are
 * read past.
 *
 * Written here rather than taken as a dependency, since the release ships the
 * dependency tree beside the code (#414), and a JUnit report needs no more of
 * XML than this. It reads as the Python standard library's parser, which the
 * step it replaces used, did: line breaks normalised, whitespace in an
 * attribute's value read as a space, the five predefined entities and
 * character references and no others, and an error that names what was wrong
 * and where, in expat's words.
 */

export interface XmlElement {
  readonly name: string;
  /**
   * Whether its name is in a namespace, by a prefix or a default `xmlns` in
   * scope: such an element is not the unqualified one of the same local name.
   */
  readonly namespaced: boolean;
  readonly attributes: ReadonlyMap<string, string>;
  /** Its character data before its first child element, comments read past. */
  readonly text: string;
  readonly children: readonly XmlElement[];
}

/** A document that is not well-formed, with where, as `<what>: line <n>, column <n>`. */
export class XmlError extends Error {}

const NAME = /[A-Za-z_:\u00C0-\uFFFF][\w.:\-\u00B7\u00C0-\uFFFF]*/y;
const SPACE = /[ \t\n]*/y;
const ENTITY = /&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z_:][\w.:-]*);/y;
const PREDEFINED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** Characters XML allows nowhere, raw or by reference. */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** The one element `source` holds, or `XmlError`. */
export const parseXml = (source: string): XmlElement => {
  const doc = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let at = 0;

  const error = (what: string, where = at): never => {
    const before = doc.slice(0, where);
    const line = before.split("\n").length;
    throw new XmlError(`${what}: line ${line}, column ${where - (before.lastIndexOf("\n") + 1)}`);
  };
  const starts = (text: string): boolean => doc.startsWith(text, at);
  const skipSpace = (): boolean => {
    SPACE.lastIndex = at;
    SPACE.test(doc);
    const moved = SPACE.lastIndex > at;
    at = SPACE.lastIndex;
    return moved;
  };
  const past = (end: string): void => {
    const found = doc.indexOf(end, at);
    if (found < 0) error("unclosed token");
    at = found + end.length;
  };
  const name = (): string => {
    NAME.lastIndex = at;
    const found = NAME.exec(doc)?.[0];
    if (found === undefined) return error("not well-formed (invalid token)");
    at += found.length;
    return found;
  };

  /** Text with its references replaced, from `start` in the document. */
  const decoded = (raw: string, start: number): string => {
    const bad = FORBIDDEN.exec(raw);
    if (bad !== null) error("not well-formed (invalid token)", start + bad.index);
    let out = "";
    let from = 0;
    for (let amp = raw.indexOf("&"); amp >= 0; amp = raw.indexOf("&", from)) {
      out += raw.slice(from, amp);
      ENTITY.lastIndex = amp;
      const ref = ENTITY.exec(raw)?.[1];
      if (ref === undefined) return error("not well-formed (invalid token)", start + amp);
      if (ref.startsWith("#")) {
        const code = ref.startsWith("#x") ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
        const valid = code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
        const char = valid ? String.fromCodePoint(code) : "";
        if (!valid || FORBIDDEN.test(char)) error("reference to invalid character number", start + amp);
        out += char;
      } else {
        const char = PREDEFINED[ref];
        if (char === undefined) return error("undefined entity", start + amp);
        out += char;
      }
      from = ENTITY.lastIndex;
    }
    return out + raw.slice(from);
  };

  /** Comments, processing instructions, a document type and space, outside the root. */
  const skipMisc = (): void => {
    for (;;) {
      skipSpace();
      if (starts("<?")) past("?>");
      else if (starts("<!--")) past("-->");
      else if (starts("<!DOCTYPE")) {
        const open = doc.indexOf("[", at);
        const close = doc.indexOf(">", at);
        if (open >= 0 && (close < 0 || open < close)) {
          at = open;
          past("]");
        }
        past(">");
      } else return;
    }
  };

  const element = (inheritedDefault: string): XmlElement => {
    at += 1;
    const tag = name();
    const attributes = new Map<string, string>();
    let empty = false;
    for (;;) {
      const spaced = skipSpace();
      if (at >= doc.length) error("unclosed token");
      if (starts("/>")) {
        at += 2;
        empty = true;
        break;
      }
      if (starts(">")) {
        at += 1;
        break;
      }
      if (!spaced) error("not well-formed (invalid token)");
      const attributeAt = at;
      const key = name();
      skipSpace();
      if (!starts("=")) error("not well-formed (invalid token)");
      at += 1;
      skipSpace();
      const quote = doc[at];
      if (quote !== '"' && quote !== "'") error("not well-formed (invalid token)");
      const close = doc.indexOf(quote as string, at + 1);
      if (close < 0) error("unclosed token");
      const raw = doc.slice(at + 1, close);
      if (raw.includes("<")) error("not well-formed (invalid token)", at + 1 + raw.indexOf("<"));
      if (attributes.has(key)) error("duplicate attribute", attributeAt);
      attributes.set(key, decoded(raw.replace(/[\t\n]/g, " "), at + 1));
      at = close + 1;
    }
    const defaultNamespace = attributes.get("xmlns") ?? inheritedDefault;
    const namespaced = tag.includes(":") || defaultNamespace !== "";
    const children: XmlElement[] = [];
    let text = "";
    const keep = (data: string): void => {
      if (children.length === 0) text += data;
    };
    if (!empty) {
      for (;;) {
        if (at >= doc.length) error("no element found");
        if (starts("</")) {
          at += 2;
          const nameAt = at;
          if (name() !== tag) error("mismatched tag", nameAt);
          skipSpace();
          if (!starts(">")) error("not well-formed (invalid token)");
          at += 1;
          break;
        }
        if (starts("<!--")) past("-->");
        else if (starts("<![CDATA[")) {
          const start = at + 9;
          at = start;
          past("]]>");
          keep(doc.slice(start, at - 3));
        } else if (starts("<?")) past("?>");
        else if (starts("<!")) error("not well-formed (invalid token)");
        else if (starts("<")) children.push(element(defaultNamespace));
        else {
          const start = at;
          const next = doc.indexOf("<", at);
          at = next < 0 ? doc.length : next;
          keep(decoded(doc.slice(start, at), start));
        }
      }
    }
    return { name: tag, namespaced, attributes, text, children };
  };

  skipMisc();
  if (at >= doc.length) error("no element found");
  if (!starts("<")) error("syntax error");
  const root = element("");
  skipMisc();
  if (at < doc.length) error("junk after document element");
  return root;
};
