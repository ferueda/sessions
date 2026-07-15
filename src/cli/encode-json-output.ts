import { assertBuiltStructuredOutput, type StructuredJsonV1 } from "./structured-output.ts";
import {
  admitEncodedStructuredOutput,
  type StructuredOutputEncodingOptions,
} from "./structured-output-encoding.ts";

export function encodeStructuredJson(
  output: StructuredJsonV1,
  options: StructuredOutputEncodingOptions = {},
): string {
  assertBuiltStructuredOutput(output);
  return admitEncodedStructuredOutput(`${JSON.stringify(output, null, 2)}\n`, options);
}
