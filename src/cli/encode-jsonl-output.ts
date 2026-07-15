import { assertBuiltStructuredOutput, type StructuredJsonlV1 } from "./structured-output.ts";
import {
  admitEncodedStructuredOutput,
  type StructuredOutputEncodingOptions,
} from "./structured-output-encoding.ts";

export function encodeStructuredJsonl(
  records: StructuredJsonlV1,
  options: StructuredOutputEncodingOptions = {},
): string {
  assertBuiltStructuredOutput(records);
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError("Structured JSONL requires at least one record");
  }
  const encoded = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  return admitEncodedStructuredOutput(encoded, options);
}
