import { Buffer } from "node:buffer";

import type { DataClearReport } from "../application/clear-index.ts";
import type { DataCompactReport } from "../application/compact-index.ts";
import type { DataRepairOrphansReport } from "../application/repair-orphaned-content.ts";
import type { ForgetSessionReport } from "../application/forget-session.ts";
import type { PathsReport } from "../application/get-paths.ts";
import type { IndexReport } from "../application/index-report.ts";
import type { ListSessionsResult } from "../application/list-sessions.ts";
import type { SearchSessionsResult } from "../application/search-sessions.ts";
import type { DoctorReport } from "../application/run-doctor.ts";
import type { ShowSessionResult } from "../application/show-session.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";
import {
  MAX_SESSION_SEARCH_BODY_BYTES,
  MAX_SESSION_SEARCH_LINKED_CONTEXT,
} from "../domain/session-query.ts";

export type OutputFormat = "human" | "json";

const MAX_SEGMENT_BYTES = 8 * 1024;
const MAX_ENTRY_BODY_BYTES = 256 * 1024;

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderDoctor(report: DoctorReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  const lines = report.checks.map(
    (check) =>
      `[${check.ok ? "pass" : "fail"}] ${renderScalar(check.label)}: ${renderScalar(check.summary)}`,
  );
  lines.push("", `Overall: ${report.ok ? "pass" : "fail"}`);
  return `${lines.join("\n")}\n`;
}

export function renderPaths(report: PathsReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  const schema =
    report.library.schemaVersion === null ? "not available" : String(report.library.schemaVersion);
  const lines = [
    `Library directory: ${renderScalar(report.library.directory)}`,
    `Scratch workspace: ${renderScalar(report.library.scratch)}`,
    `Library database: ${renderScalar(report.library.database)}`,
    `Library WAL: ${renderScalar(report.library.wal)}`,
    `Library shared memory: ${renderScalar(report.library.shm)}`,
    `Initialized: ${report.library.initialized ? "yes" : "no"}`,
    `State: ${report.library.state}`,
    `Schema: ${schema} (supported: ${String(report.library.supportedSchemaVersion)})`,
  ];
  for (const source of report.sources) {
    const status = source.probe.status === "failed" ? source.probe.failure : source.probe.status;
    lines.push(`Source ${renderScalar(source.source.kind)}: ${status}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderIndex(report: IndexReport, format: OutputFormat): string {
  if (format === "json") return renderJson(report);
  const lines = report.sources.map(
    (source) =>
      `${renderScalar(source.source.kind)}: ${source.status}; ${String(source.counts.updated)} updated, ${String(source.counts.unchanged)} unchanged, ${String(source.counts.failed)} failed, ${String(source.counts.missing)} missing`,
  );
  lines.push(
    `Total: ${String(report.counts.discovered)} discovered; ${String(report.incompleteSources)} incomplete source(s)`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderForget(report: ForgetSessionReport, format: OutputFormat): string {
  return format === "json"
    ? renderJson(report)
    : `${report.outcome === "forgotten" ? "Forgot" : "No retained session for"} ${renderScalar(report.identity.canonicalId)}.\n`;
}

export function renderDataClear(report: DataClearReport, format: OutputFormat): string {
  return format === "json"
    ? renderJson(report)
    : `${report.outcome === "cleared" ? "Sessions data cleared." : "No Sessions data found."}\n`;
}

export function renderDataCompact(report: DataCompactReport, format: OutputFormat): string {
  return format === "json"
    ? renderJson(report)
    : `Compaction outcome: ${report.outcome}. Database bytes before: ${String(report.databaseBytesBefore)}; after: ${String(report.databaseBytesAfter)}; reclaimed: ${String(report.reclaimedDatabaseBytes)}.\n`;
}

export function renderDataRepairOrphans(
  report: DataRepairOrphansReport,
  format: OutputFormat,
): string {
  return format === "json"
    ? renderJson(report)
    : `Orphan repair outcome: ${report.outcome}. Deleted canonical content rows: ${report.deletedContentRows}; deleted logical UTF-8 bytes: ${report.deletedContentBytes}.\n`;
}

export function renderList(result: ListSessionsResult): string {
  if (result.sessions.length === 0) return "No sessions found.\n";
  const lines = result.sessions.map((session) => {
    const identity = renderScalar(formatSessionIdentity(session.identity));
    const title = session.title === undefined ? "(untitled)" : renderScalar(session.title);
    const capture = session.capturedAt === undefined ? "capture unknown" : session.capturedAt;
    return `${identity}  ${title}  [${session.freshness}; ${session.sourceState}; ${capture}]`;
  });
  if (result.nextCursor !== undefined) {
    lines.push(`Next cursor: ${renderScalar(result.nextCursor)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderSearch(result: SearchSessionsResult): string {
  if (result.hits.length === 0) return "No matches found.\n";

  const lines: string[] = [];
  for (const [index, hit] of result.hits.entries()) {
    if (index > 0) lines.push("");
    const identity = renderScalar(formatSessionIdentity(hit.session.identity));
    const title = hit.session.title === undefined ? "(untitled)" : renderScalar(hit.session.title);
    const capture =
      hit.session.capturedAt === undefined ? "capture unknown" : hit.session.capturedAt;
    lines.push(
      `${identity}  ${title}  [${hit.session.freshness}; ${hit.session.sourceState}; ${capture}]`,
      renderEntryHeading(hit.entry),
      renderSearchBody(hit.snippet.text, hit.snippet.truncated),
      `Evidence: segment #${String(hit.snippet.segmentOrdinal)}; ${hit.snippet.origin}/${hit.snippet.originConfidence}; ${String(hit.snippet.additionalMatchingSegments)} additional matching segment(s)`,
    );
    for (const context of hit.context) {
      const relation =
        context.adjacent && context.linked
          ? "adjacent+linked"
          : context.linked
            ? "linked"
            : "adjacent";
      lines.push(
        `Context (${relation}) ${renderEntryHeading(context)}`,
        renderSearchBody(context.body, context.bodyTruncated),
      );
    }
    if (hit.linkedContextTruncated) {
      lines.push(
        `Linked context: truncated at ${String(MAX_SESSION_SEARCH_LINKED_CONTEXT)} entries`,
      );
    }
  }

  lines.push(
    "",
    `Support: ${String(result.support.occurrences)} occurrence(s); ${String(result.support.uniqueContent)} unique content value(s); ${String(result.support.uniqueKnownRoots)} known root(s); ${String(result.support.unknownLineageSessions)} unknown-lineage session(s)`,
  );
  if (result.nextCursor !== undefined) {
    lines.push(`Next cursor: ${renderScalar(result.nextCursor)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderShow(result: ShowSessionResult): string {
  const capture =
    result.summary.capturedAt === undefined ? "capture unknown" : result.summary.capturedAt;
  const lines = [
    `${renderScalar(formatSessionIdentity(result.summary.identity))}  [${result.summary.freshness}; ${result.summary.sourceState}; ${capture}]`,
    result.summary.title === undefined ? "(untitled)" : renderScalar(result.summary.title),
    `Entries: ${rangeLabel(result)}`,
    "",
  ];
  for (const entry of result.entries) {
    const heading = renderEntryHeading(entry);
    const body = entry.content
      .map((segment) =>
        segment.kind === "text"
          ? renderScalar(segment.text)
          : `<omitted ${segment.contentClass} ${renderScalar(segment.sourceType)}>`,
      )
      .join("\n");
    const boundedBody = truncateUtf8(body, MAX_ENTRY_BODY_BYTES);
    lines.push(heading, boundedBody.length === 0 ? "(no content)" : boundedBody, "");
  }
  return `${lines.join("\n")}\n`;
}

export function escapeScalar(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      output += `\\u{${code.toString(16).padStart(2, "0")}}`;
    } else {
      output += character;
    }
  }
  return output;
}

function renderScalar(value: string): string {
  return truncateUtf8(escapeScalar(value), MAX_SEGMENT_BYTES);
}

function renderEntryHeading(entry: {
  readonly ordinal: number;
  readonly actor: string;
  readonly kind: string;
  readonly timestamp?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly toolCallId?: string;
  readonly relatedEntryOrdinal?: number;
}): string {
  const values = [`#${String(entry.ordinal)}`, renderScalar(entry.actor), renderScalar(entry.kind)];
  if (entry.timestamp !== undefined) values.push(entry.timestamp);
  if (entry.toolName !== undefined) {
    const tool =
      entry.toolNamespace === undefined
        ? entry.toolName
        : `${entry.toolNamespace}/${entry.toolName}`;
    values.push(`tool=${renderScalar(tool)}`);
  }
  if (entry.toolCallId !== undefined) values.push(`call=${renderScalar(entry.toolCallId)}`);
  if (entry.relatedEntryOrdinal !== undefined) {
    values.push(`related=#${String(entry.relatedEntryOrdinal)}`);
  }
  return truncateUtf8(values.join(" "), MAX_SEGMENT_BYTES);
}

function renderSearchBody(value: string, alreadyTruncated: boolean): string {
  const escaped = escapeScalar(value);
  const bounded = truncateUtf8(escaped, MAX_SESSION_SEARCH_BODY_BYTES);
  if (!alreadyTruncated || bounded.endsWith("… [truncated]")) return bounded;
  return truncateUtf8(`${bounded} … [truncated]`, MAX_SESSION_SEARCH_BODY_BYTES);
}

function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const suffix = "… [truncated]";
  const budget = maximum - Buffer.byteLength(suffix, "utf8");
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return `${output}${suffix}`;
}

function rangeLabel(result: ShowSessionResult): string {
  if (result.firstEntry === null || result.lastEntry === null)
    return `none of ${result.totalEntries}`;
  return `${String(result.firstEntry)}–${String(result.lastEntry)} of ${String(result.totalEntries)}`;
}
