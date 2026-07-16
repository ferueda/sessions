import type {
  SessionEntryFilter,
  SessionFilter,
  SessionSearchFilter,
} from "../../domain/session-query.ts";

export interface SqliteQueryWhere {
  readonly sql: string;
  readonly parameters: readonly string[];
}

export const EFFECTIVE_SOURCE_STATE_SQL = `CASE
  WHEN source.coverage_status = 'unknown' THEN 'unknown'
  WHEN source.coverage_status = 'complete' THEN tracking.presence_status
  ELSE NULL
END`;

export const EFFECTIVE_SOURCE_OBSERVED_AT_SQL = `CASE
  WHEN source.coverage_status = 'unknown' THEN source.coverage_observed_at
  WHEN source.coverage_status = 'complete' THEN tracking.presence_observed_at
  ELSE NULL
END`;

export const EFFECTIVE_SESSION_ACTIVITY_SQL =
  "COALESCE(canonical.updated_at, canonical.created_at)";

export function sessionWhere(filter: SessionFilter): SqliteQueryWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendCommonFilters(conditions, parameters, filter);
  return where(conditions, parameters);
}

export function searchWhere(filter: SessionSearchFilter): SqliteQueryWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendCommonFilters(conditions, parameters, filter);
  appendExclusiveBound(conditions, parameters, "entry.timestamp", ">", filter.entryAfter);
  appendExclusiveBound(conditions, parameters, "entry.timestamp", "<", filter.entryBefore);
  appendExact(conditions, parameters, "entry.actor", filter.actor);
  appendExact(conditions, parameters, "occurrence.origin", filter.origin);
  appendExact(conditions, parameters, "entry.kind", filter.entryKind);
  if (filter.toolName !== undefined || filter.toolNamespace !== undefined) {
    conditions.push("entry.kind = 'tool-call'");
  }
  appendExact(conditions, parameters, "entry.tool_name", filter.toolName);
  appendExact(conditions, parameters, "entry.tool_namespace", filter.toolNamespace);
  return where(conditions, parameters);
}

export function entryInventoryWhere(filter: SessionEntryFilter): SqliteQueryWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendCommonFilters(conditions, parameters, filter);
  appendEntryFilters(conditions, parameters, filter, "entry");
  return where(conditions, parameters);
}

export function entrySelectionWhere(
  filter: SessionEntryFilter,
  entryAlias: string,
): SqliteQueryWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendEntryFilters(conditions, parameters, filter, entryAlias);
  return where(conditions, parameters);
}

function appendEntryFilters(
  conditions: string[],
  parameters: string[],
  filter: SessionEntryFilter,
  entryAlias: string,
): void {
  appendExclusiveBound(conditions, parameters, `${entryAlias}.timestamp`, ">", filter.entryAfter);
  appendExclusiveBound(conditions, parameters, `${entryAlias}.timestamp`, "<", filter.entryBefore);
  appendExact(conditions, parameters, `${entryAlias}.actor`, filter.actor);
  if (filter.origin !== undefined) {
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM sessions_content_occurrences AS origin_occurrence
        WHERE origin_occurrence.session_id = ${entryAlias}.session_id
          AND origin_occurrence.entry_ordinal = ${entryAlias}.ordinal
          AND origin_occurrence.origin = ?
      )`,
    );
    parameters.push(filter.origin);
  }
  appendExact(conditions, parameters, `${entryAlias}.kind`, filter.entryKind);
  if (filter.toolName !== undefined || filter.toolNamespace !== undefined) {
    conditions.push(`${entryAlias}.kind = 'tool-call'`);
  }
  appendExact(conditions, parameters, `${entryAlias}.tool_name`, filter.toolName);
  appendExact(conditions, parameters, `${entryAlias}.tool_namespace`, filter.toolNamespace);
}

function appendCommonFilters(
  conditions: string[],
  parameters: string[],
  filter: SessionFilter,
): void {
  appendExact(conditions, parameters, "source.kind", filter.source);
  appendExact(conditions, parameters, "source.instance_id", filter.instance);
  appendExact(conditions, parameters, "tracking.native_id", filter.nativeId);
  appendExact(conditions, parameters, EFFECTIVE_SOURCE_STATE_SQL, filter.sourceState);
  appendExact(conditions, parameters, "canonical.workspace", filter.workspace);
  appendExclusiveBound(
    conditions,
    parameters,
    EFFECTIVE_SESSION_ACTIVITY_SQL,
    ">",
    filter.activityAfter,
  );
  appendExclusiveBound(
    conditions,
    parameters,
    EFFECTIVE_SESSION_ACTIVITY_SQL,
    "<",
    filter.activityBefore,
  );
  appendExclusiveBound(conditions, parameters, "tracking.captured_at", ">", filter.capturedAfter);
  appendExclusiveBound(conditions, parameters, "tracking.captured_at", "<", filter.capturedBefore);
  appendExclusiveBound(
    conditions,
    parameters,
    EFFECTIVE_SOURCE_OBSERVED_AT_SQL,
    ">",
    filter.observedAfter,
  );
  appendExclusiveBound(
    conditions,
    parameters,
    EFFECTIVE_SOURCE_OBSERVED_AT_SQL,
    "<",
    filter.observedBefore,
  );
  if (filter.session !== undefined) {
    appendExact(conditions, parameters, "source.kind", filter.session.source.kind);
    appendExact(conditions, parameters, "source.instance_id", filter.session.source.instanceId);
    appendExact(conditions, parameters, "tracking.native_id", filter.session.nativeId);
  }
}

function appendExact(
  conditions: string[],
  parameters: string[],
  expression: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  conditions.push(`${expression} = ?`);
  parameters.push(value);
}

function appendExclusiveBound(
  conditions: string[],
  parameters: string[],
  expression: string,
  operator: ">" | "<",
  value: string | undefined,
): void {
  if (value === undefined) return;
  conditions.push(`${expression} ${operator} ?`);
  parameters.push(value);
}

function where(conditions: readonly string[], parameters: readonly string[]): SqliteQueryWhere {
  return {
    sql: conditions.length === 0 ? "" : ` AND ${conditions.join(" AND ")}`,
    parameters,
  };
}
