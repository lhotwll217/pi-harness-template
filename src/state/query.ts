// Read-only SQL access behind `pi-template db` and query_database: list tables → describe one →
// run a bounded SELECT. Each call opens and closes a fresh handle so startup and replacement
// of the durable database are visible without keeping an extra long-lived connection.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { defaultDbPath } from "./database";
import { tableDoc } from "./schema-docs";

export interface TableInfo {
  name: string;
  rows: number;
  /** Git-tracked description from schema-docs.ts, never the database file. */
  description: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  /** "(undocumented)" makes executable-schema drift visible to the caller. */
  description: string;
}

export interface TableDescription {
  description: string;
  columns: ColumnInfo[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** True when the cap cut the result; the caller should narrow the SELECT. */
  truncated: boolean;
}

/**
 * A refusal the caller can act on: `hint` says what to run or change, and `closest` names the
 * existing tables nearest an unknown one. Both are own fields, so they travel in the error body.
 */
export class DatabaseQueryError extends Error {
  constructor(message: string, readonly hint: string, readonly closest?: string[]) {
    super(message);
  }
}

export const QUERY_ROW_CAP = 200;
export const QUERY_TIME_LIMIT_MS = 5_000;

const TABLES_HINT = "`pi-template db tables` lists every table.";

function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function requireDatabase(dbPath: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`no state database at ${dbPath} — the daemon has not initialized it`);
  }
}

function withDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  requireDatabase(dbPath);
  const db = openReadOnly(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const tableNames = (db: DatabaseSync): string[] => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all() as Array<{ name: string }>).map(({ name }) => name);

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length]!;
}

function nearest(wanted: string, tables: readonly string[]): string[] {
  const target = wanted.toLowerCase();
  return tables
    .map((name) => {
      const table = name.toLowerCase();
      return { name, score: table.includes(target) || target.includes(table) ? 0 : editDistance(target, table) };
    })
    .filter(({ score }) => score <= 3)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name);
}

// Names, columns, constraints, and row counts are live. Descriptions are reviewed code.
// Keeping those sources separate exposes drift instead of trusting frozen CREATE text.
export function listTables(dbPath: string = defaultDbPath()): TableInfo[] {
  return withDatabase(dbPath, (db) => tableNames(db).map((name) => {
    const escaped = name.replaceAll('"', '""');
    const { rows } = db.prepare(`SELECT COUNT(*) AS rows FROM "${escaped}"`).get() as { rows: number };
    return { name, rows, description: tableDoc(name)?.description ?? "(undocumented)" };
  }));
}

export function describeTable(table: string, dbPath: string = defaultDbPath()): TableDescription {
  return withDatabase(dbPath, (db) => {
    const tables = tableNames(db);
    if (!tables.includes(table)) {
      throw new DatabaseQueryError(`no such table: ${table}`, TABLES_HINT, nearest(table, tables));
    }

    const doc = tableDoc(table);
    const columnDocs = new Map((doc?.columns ?? []).map((column) => [column.name, column.description]));
    const escaped = table.replaceAll('"', '""');
    const columns = db.prepare(`PRAGMA table_info("${escaped}")`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    return {
      description: doc?.description ?? "(undocumented)",
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull !== 0,
        primaryKey: column.pk !== 0,
        description: columnDocs.get(column.name) ?? "(undocumented)",
      })),
    };
  });
}

// Runs in a separate Node process so a runaway query can be killed: node:sqlite has no
// interrupt or progress handler, and a worker thread stuck in one native step cannot be
// terminated.
const QUERY_PROCESS_SOURCE = `
const { DatabaseSync, constants } = require("node:sqlite");
let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => { input += chunk; }).on("end", () => {
  const { sql, dbPath, cap } = JSON.parse(input);
  let result;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      // Only reading is authorized from here on: ATTACH, DETACH, PRAGMA and every write are
      // denied whatever the SQL text looks like. The read-only handle stays as a second layer.
      const c = constants;
      const allowed = new Set([c.SQLITE_SELECT, c.SQLITE_READ, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE]);
      db.setAuthorizer((action) => allowed.has(action) ? c.SQLITE_OK : c.SQLITE_DENY);
      const rows = [];
      let truncated = false;
      for (const row of db.prepare(sql).iterate()) {
        if (rows.length === cap) { truncated = true; break; }
        rows.push({ ...row });
      }
      result = { rows, truncated };
    } finally {
      db.close();
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(result));
});
`;

function sqlError(message: string, dbPath: string): DatabaseQueryError {
  const missing = /no such table: (\S+)/i.exec(message)?.[1];
  if (missing !== undefined) {
    return new DatabaseQueryError(message, TABLES_HINT, withDatabase(dbPath, (db) => nearest(missing, tableNames(db))));
  }
  if (/no such column/i.test(message)) return new DatabaseQueryError(message, "`pi-template db describe <table>` lists its columns.");
  if (/not authorized|readonly/i.test(message)) {
    return new DatabaseQueryError(message, "`pi-template db query` runs one read-only SELECT against the state database.");
  }
  return new DatabaseQueryError(message, "`pi-template db describe <table>` shows a table's columns.");
}

export async function runQuery(sql: string, dbPath: string = defaultDbPath()): Promise<QueryResult> {
  requireDatabase(dbPath);
  const outcome = await new Promise<QueryResult | { error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", QUERY_PROCESS_SOURCE], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new DatabaseQueryError(
        `query stopped after ${QUERY_TIME_LIMIT_MS / 1000} s`,
        "Add WHERE or LIMIT, and bound any recursive CTE.",
      ));
    }, QUERY_TIME_LIMIT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output) as QueryResult | { error: string });
      } catch {
        reject(new Error("the query process ended without a result"));
      }
    });
    child.stdin.end(JSON.stringify({ sql, dbPath, cap: QUERY_ROW_CAP }));
  });
  if ("error" in outcome) throw sqlError(outcome.error, dbPath);
  return outcome;
}
