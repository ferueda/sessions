import { isCanonicalTimestamp } from "./canonical-timestamp.ts";
import type { ContentHash } from "./content-hash.ts";
import type { SessionDocumentDigest } from "./public-session-document.ts";
import type { SessionRootResolution } from "./session-lineage.ts";
import { isSessionIdentity } from "./session-identity.ts";
import type { Actor, ContentOrigin, OriginConfidence, SessionIdentity } from "./session.ts";
import { splitUnicodeWhitespaceTerms } from "./unicode-whitespace.ts";

export const MAX_SESSION_QUERY_LIMIT = 200;
export const MAX_ENTRY_LIST_LIMIT = MAX_SESSION_QUERY_LIMIT;
export const MAX_SESSION_SEARCH_CONTEXT = 10;
export const MAX_SESSION_SEARCH_BODY_BYTES = 512;
export const MAX_SESSION_SEARCH_LINKED_CONTEXT = 20;
export const MAX_SESSION_QUERY_CURSOR_LENGTH = 2_048;

declare const sessionQueryCursorBrand: unique symbol;
declare const sessionListQueryBrand: unique symbol;
declare const sessionSearchQueryBrand: unique symbol;
declare const sessionEntryQueryBrand: unique symbol;

export type SessionQueryCursor = string & {
  readonly [sessionQueryCursorBrand]: "SessionQueryCursor";
};

export type SessionSourceState = "present" | "missing" | "unknown";

export interface SessionFilterInput {
  readonly source?: string;
  readonly instance?: string;
  readonly nativeId?: string;
  readonly sourceState?: SessionSourceState;
  readonly workspace?: string;
  readonly capturedAfter?: string;
  readonly capturedBefore?: string;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  readonly session?: SessionIdentity;
}

export interface SessionFilter extends SessionFilterInput {
  readonly session?: SessionIdentity;
}

export interface SessionEntryFilterInput extends SessionFilterInput {
  readonly entryAfter?: string;
  readonly entryBefore?: string;
  readonly actor?: Actor;
  readonly origin?: ContentOrigin;
  readonly entryKind?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
}

export interface SessionEntryFilter extends SessionFilter, SessionEntryFilterInput {}

export interface SessionSearchFilterInput extends SessionEntryFilterInput {}

export interface SessionSearchFilter extends SessionEntryFilter {}

export type SessionEntrySelection = "all" | "first" | "last";

export interface SessionListQueryInput {
  readonly filter?: SessionFilterInput;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SessionListQuery {
  readonly [sessionListQueryBrand]: "SessionListQuery";
  readonly filter: SessionFilter;
  readonly limit: number;
  readonly cursor?: SessionQueryCursor;
}

export interface SessionSearchQueryInput {
  readonly text: string;
  readonly filter?: SessionSearchFilterInput;
  readonly limit: number;
  readonly context: number;
  readonly cursor?: string;
}

export interface SessionSearchQuery {
  readonly [sessionSearchQueryBrand]: "SessionSearchQuery";
  readonly text: string;
  readonly filter: SessionSearchFilter;
  readonly limit: number;
  readonly context: number;
  readonly cursor?: SessionQueryCursor;
}

export interface SessionEntryQueryInput {
  readonly filter?: SessionEntryFilterInput;
  readonly selection?: SessionEntrySelection;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SessionEntryQuery {
  readonly [sessionEntryQueryBrand]: "SessionEntryQuery";
  readonly filter: SessionEntryFilter;
  readonly selection: SessionEntrySelection;
  readonly limit: number;
  readonly cursor?: SessionQueryCursor;
}

export interface SessionQuerySummary {
  readonly identity: SessionIdentity;
  readonly title?: string;
  readonly workspace?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly freshness: "current" | "stale";
  readonly sourceState: SessionSourceState;
  readonly capturedAt: string;
  readonly sourceObservedAt: string;
  readonly adapterVersion: string;
  readonly documentDigest: SessionDocumentDigest;
}

export interface SessionListPage {
  readonly sessions: readonly SessionQuerySummary[];
  readonly nextCursor?: SessionQueryCursor;
}

export interface SessionSearchEntry {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: Actor;
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
}

export interface SessionSearchSnippet {
  readonly segmentOrdinal: number;
  readonly origin: ContentOrigin;
  readonly originConfidence: OriginConfidence;
  readonly contentHash: ContentHash;
  readonly text: string;
  readonly truncated: boolean;
  readonly additionalMatchingSegments: number;
}

export interface SessionSearchContextEntry extends SessionSearchEntry {
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly adjacent: boolean;
  readonly linked: boolean;
}

export interface SessionSearchHit {
  readonly session: SessionQuerySummary;
  readonly entry: SessionSearchEntry;
  readonly snippet: SessionSearchSnippet;
  readonly context: readonly SessionSearchContextEntry[];
  readonly linkedContextTruncated: boolean;
}

export interface SessionSearchSupport {
  readonly occurrences: number;
  readonly uniqueContent: number;
  readonly uniqueKnownRoots: number;
  readonly unknownLineageSessions: number;
}

export interface SessionSearchPage {
  readonly hits: readonly SessionSearchHit[];
  readonly support: SessionSearchSupport;
  readonly nextCursor?: SessionQueryCursor;
}

export interface SessionEntryPreview {
  readonly segmentOrdinal: number;
  readonly origin: ContentOrigin;
  readonly originConfidence: OriginConfidence;
  readonly contentHash: ContentHash;
  readonly text: string;
  readonly truncated: boolean;
}

export interface SessionEntryContentSummary {
  readonly textSegmentCount: number;
  readonly omittedSegmentCount: number;
  readonly unpreviewedTextSegmentCount: number;
  readonly preview?: SessionEntryPreview;
}

export interface SessionEntryInventoryItem {
  readonly session: SessionQuerySummary;
  readonly entry: SessionSearchEntry;
  readonly root: SessionRootResolution;
  readonly content: SessionEntryContentSummary;
}

export interface SessionEntryPage {
  readonly entries: readonly SessionEntryInventoryItem[];
  readonly nextCursor?: SessionQueryCursor;
}

const SOURCE_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ACTORS = new Set<Actor>(["human", "model", "tool", "system", "unknown"]);
const ORIGINS = new Set<ContentOrigin>([
  "human",
  "injected",
  "delegated",
  "replayed-copied",
  "model",
  "tool",
  "system",
  "unknown",
]);
const SOURCE_STATES = new Set<SessionSourceState>(["present", "missing", "unknown"]);
const ENTRY_SELECTIONS = new Set<SessionEntrySelection>(["all", "first", "last"]);

export function createSessionQueryCursor(value: unknown): SessionQueryCursor {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SESSION_QUERY_CURSOR_LENGTH ||
    !value.isWellFormed()
  ) {
    throw new TypeError("Session query cursor is invalid");
  }
  return value as SessionQueryCursor;
}

export function createSessionFilter(input: SessionFilterInput = {}): SessionFilter {
  return createFilter(input, false);
}

export function createSessionSearchFilter(
  input: SessionSearchFilterInput = {},
): SessionSearchFilter {
  return createFilter(input, true);
}

export function createSessionEntryFilter(input: SessionEntryFilterInput = {}): SessionEntryFilter {
  return createFilter(input, true);
}

export function createSessionListQuery(input: SessionListQueryInput): SessionListQuery {
  const filter = createSessionFilter(input.filter);
  const limit = boundedInteger(input.limit, 1, MAX_SESSION_QUERY_LIMIT, "List limit");
  const cursor = input.cursor === undefined ? undefined : createSessionQueryCursor(input.cursor);
  return Object.freeze({
    filter,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  }) as SessionListQuery;
}

export function createSessionSearchQuery(input: SessionSearchQueryInput): SessionSearchQuery {
  const text = canonicalSearchText(input.text);
  const filter = createSessionSearchFilter(input.filter);
  const limit = boundedInteger(input.limit, 1, MAX_SESSION_QUERY_LIMIT, "Search limit");
  const context = boundedInteger(input.context, 0, MAX_SESSION_SEARCH_CONTEXT, "Search context");
  const cursor = input.cursor === undefined ? undefined : createSessionQueryCursor(input.cursor);
  return Object.freeze({
    text,
    filter,
    limit,
    context,
    ...(cursor === undefined ? {} : { cursor }),
  }) as SessionSearchQuery;
}

export function createSessionEntryQuery(input: SessionEntryQueryInput): SessionEntryQuery {
  const filter = createSessionEntryFilter(input.filter);
  const selection = optionalLiteral(input.selection, ENTRY_SELECTIONS, "Entry selection") ?? "all";
  const limit = boundedInteger(input.limit, 1, MAX_ENTRY_LIST_LIMIT, "Entry limit");
  const cursor = input.cursor === undefined ? undefined : createSessionQueryCursor(input.cursor);
  return Object.freeze({
    filter,
    selection,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  }) as SessionEntryQuery;
}

/** Stable, cursor-independent material for binding a continuation to query semantics. */
export function sessionQueryFingerprintMaterial(
  query: SessionListQuery | SessionSearchQuery | SessionEntryQuery,
): string {
  const filter = query.filter;
  const common = [
    filter.source ?? null,
    filter.instance ?? null,
    filter.sourceState ?? null,
    filter.workspace ?? null,
    filter.capturedAfter ?? null,
    filter.capturedBefore ?? null,
    filter.observedAfter ?? null,
    filter.observedBefore ?? null,
    filter.nativeId ?? null,
    filter.session?.source.kind ?? null,
    filter.session?.source.instanceId ?? null,
    filter.session?.nativeId ?? null,
  ];
  if ("selection" in query) {
    return JSON.stringify([
      "sessions-query-v1",
      "entries",
      query.selection,
      query.limit,
      ...common,
      query.filter.entryAfter ?? null,
      query.filter.entryBefore ?? null,
      query.filter.actor ?? null,
      query.filter.origin ?? null,
      query.filter.entryKind ?? null,
      query.filter.toolName ?? null,
      query.filter.toolNamespace ?? null,
    ]);
  }
  if (!("text" in query)) {
    return JSON.stringify(["sessions-query-v1", "list", query.limit, ...common]);
  }
  return JSON.stringify([
    "sessions-query-v1",
    "search",
    query.text,
    query.limit,
    query.context,
    ...common,
    query.filter.entryAfter ?? null,
    query.filter.entryBefore ?? null,
    query.filter.actor ?? null,
    query.filter.origin ?? null,
    query.filter.entryKind ?? null,
    query.filter.toolName ?? null,
    query.filter.toolNamespace ?? null,
  ]);
}

function createFilter(input: SessionEntryFilterInput, search: true): SessionEntryFilter;
function createFilter(input: SessionFilterInput, search: false): SessionFilter;
function createFilter(
  input: SessionFilterInput | SessionEntryFilterInput,
  search: boolean,
): SessionFilter | SessionEntryFilter {
  const source = optionalSource(input.source);
  const instance = optionalOpaque(input.instance, "Source instance");
  if (instance !== undefined && source === undefined) {
    throw new TypeError("Source instance requires a source");
  }
  const nativeId = optionalOpaque(input.nativeId, "Native ID");
  const sourceState = optionalLiteral(input.sourceState, SOURCE_STATES, "Source state");
  const workspace = optionalExact(input.workspace, "Workspace");
  const capturedAfter = optionalTimestamp(input.capturedAfter, "Captured-after");
  const capturedBefore = optionalTimestamp(input.capturedBefore, "Captured-before");
  validateBounds(capturedAfter, capturedBefore, "Capture");
  const observedAfter = optionalTimestamp(input.observedAfter, "Observed-after");
  const observedBefore = optionalTimestamp(input.observedBefore, "Observed-before");
  validateBounds(observedAfter, observedBefore, "Observation");
  const session = snapshotIdentity(input.session);

  const common = {
    ...(source === undefined ? {} : { source }),
    ...(instance === undefined ? {} : { instance }),
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(sourceState === undefined ? {} : { sourceState }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(capturedAfter === undefined ? {} : { capturedAfter }),
    ...(capturedBefore === undefined ? {} : { capturedBefore }),
    ...(observedAfter === undefined ? {} : { observedAfter }),
    ...(observedBefore === undefined ? {} : { observedBefore }),
    ...(session === undefined ? {} : { session }),
  };
  if (!search) return Object.freeze(common);

  const searchInput = input as SessionEntryFilterInput;
  const entryAfter = optionalTimestamp(searchInput.entryAfter, "Entry-after");
  const entryBefore = optionalTimestamp(searchInput.entryBefore, "Entry-before");
  validateBounds(entryAfter, entryBefore, "Entry");
  const actor = optionalLiteral(searchInput.actor, ACTORS, "Actor");
  const origin = optionalLiteral(searchInput.origin, ORIGINS, "Origin");
  const entryKind = optionalExact(searchInput.entryKind, "Entry kind");
  const toolName = optionalExact(searchInput.toolName, "Tool name");
  const toolNamespace = optionalExact(searchInput.toolNamespace, "Tool namespace");
  return Object.freeze({
    ...common,
    ...(entryAfter === undefined ? {} : { entryAfter }),
    ...(entryBefore === undefined ? {} : { entryBefore }),
    ...(actor === undefined ? {} : { actor }),
    ...(origin === undefined ? {} : { origin }),
    ...(entryKind === undefined ? {} : { entryKind }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolNamespace === undefined ? {} : { toolNamespace }),
  });
}

function optionalSource(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!SOURCE_KIND_PATTERN.test(value)) throw new TypeError("Source is invalid");
  return value;
}

function optionalExact(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.isWellFormed()) throw new TypeError(`${label} must be a well-formed string`);
  return value;
}

function optionalOpaque(value: string | undefined, label: string): string | undefined {
  const exact = optionalExact(value, label);
  if (exact === "") throw new TypeError(`${label} must not be empty`);
  return exact;
}

function optionalLiteral<T extends string>(
  value: T | undefined,
  allowed: ReadonlySet<T>,
  label: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.has(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function optionalTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isCanonicalTimestamp(value)) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function validateBounds(
  after: string | undefined,
  before: string | undefined,
  label: string,
): void {
  if (after !== undefined && before !== undefined && after >= before) {
    throw new TypeError(`${label} bounds must be increasing and exclusive`);
  }
}

function snapshotIdentity(value: SessionIdentity | undefined): SessionIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isSessionIdentity(value)) throw new TypeError("Session identity is invalid");
  return Object.freeze({
    source: Object.freeze({ kind: value.source.kind, instanceId: value.source.instanceId }),
    nativeId: value.nativeId,
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${label} must be an integer from ${String(minimum)} through ${String(maximum)}`,
    );
  }
  return value;
}

function canonicalSearchText(value: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new TypeError("Search text must be a well-formed string");
  }
  const terms = splitUnicodeWhitespaceTerms(value);
  if (terms.length === 0) throw new TypeError("Search text must not be blank");
  return terms.join(" ");
}
