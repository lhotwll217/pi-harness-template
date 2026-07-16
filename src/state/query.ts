// Read-only SQL access behind query_database: list tables → describe one → run a
// bounded SELECT. Each call opens and closes a fresh handle so startup and replacement
// of the durable database are visible without keeping an extra long-lived connection.

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

export const QUERY_ROW_CAP = 200;

function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function withDatabase<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) {
    throw new Error(`no state database at ${dbPath} — the daemon has not initialized it`);
  }
  const db = openReadOnly(dbPath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

// Names, columns, constraints, and row counts are live. Descriptions are reviewed code.
// Keeping those sources separate exposes drift instead of trusting frozen CREATE text.
export function listTables(dbPath: string = defaultDbPath()): TableInfo[] {
  return withDatabase(dbPath, (db) => {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      const escaped = name.replaceAll('"', '""');
      const { rows } = db.prepare(`SELECT COUNT(*) AS rows FROM "${escaped}"`).get() as { rows: number };
      return { name, rows, description: tableDoc(name)?.description ?? "(undocumented)" };
    });
  });
}

export function describeTable(table: string, dbPath: string = defaultDbPath()): TableDescription {
  return withDatabase(dbPath, (db) => {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) throw new Error(`no such table: ${table}`);

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

export function runQuery(sql: string, dbPath: string = defaultDbPath()): QueryResult {
  // Read-only SQLite blocks mutations. ATTACH is the remaining cross-file read surface,
  // so close it explicitly while leaving ordinary SELECT text untouched.
  const withoutComments = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  if (/(^|;)\s*(attach|detach)\b/i.test(withoutComments)) {
    throw new Error("ATTACH/DETACH is not allowed; query only the Pi Template state database");
  }

  return withDatabase(dbPath, (db) => {
    const rows: Record<string, unknown>[] = [];
    for (const row of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length === QUERY_ROW_CAP) return { rows, truncated: true };
      rows.push({ ...row });
    }
    return { rows, truncated: false };
  });
}
