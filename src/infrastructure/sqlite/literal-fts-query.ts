import { splitUnicodeWhitespaceTerms } from "../../domain/unicode-whitespace.ts";
import type { SessionSearchTermMode } from "../../domain/session-query.ts";

/** Translate public text into quoted FTS data, never FTS syntax. */
export function literalFtsQuery(
  text: string,
  termMode: SessionSearchTermMode = "all",
): string | undefined {
  if (typeof text !== "string" || !text.isWellFormed()) {
    throw new TypeError("Search text must be a well-formed string");
  }
  const terms = splitUnicodeWhitespaceTerms(text);
  if (terms.length === 0) return undefined;
  const operator = termOperator(termMode);
  return terms.map(quoteLiteralTerm).join(operator);
}

function quoteLiteralTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function termOperator(termMode: SessionSearchTermMode): " AND " | " OR " {
  switch (termMode) {
    case "all":
      return " AND ";
    case "any":
      return " OR ";
    default:
      throw new TypeError("Search term mode is invalid");
  }
}
