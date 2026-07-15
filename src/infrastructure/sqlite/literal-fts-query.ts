import { splitUnicodeWhitespaceTerms } from "../../domain/unicode-whitespace.ts";

/** Translate public text into quoted FTS data, never FTS syntax. */
export function literalFtsQuery(text: string): string | undefined {
  if (typeof text !== "string" || !text.isWellFormed()) {
    throw new TypeError("Search text must be a well-formed string");
  }
  const terms = splitUnicodeWhitespaceTerms(text);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}
