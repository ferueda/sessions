const UNICODE_WHITE_SPACE = /\p{White_Space}+/u;

/** Split terms on the Unicode White_Space property, including U+0085. */
export function splitUnicodeWhitespaceTerms(value: string): string[] {
  return value.split(UNICODE_WHITE_SPACE).filter((term) => term.length > 0);
}
