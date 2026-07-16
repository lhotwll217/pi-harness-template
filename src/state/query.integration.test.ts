import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { State } from "./state";
import { describeTable, listTables, QUERY_ROW_CAP, runQuery } from "./query";

const dir = mkdtempSync(join(tmpdir(), "pi-template-query-"));
const dbPath = join(dir, "state.db");

try {
  assert.throws(() => listTables(join(dir, "missing.db")), /has not initialized/i);

  let id = 0;
  const state = new State(dbPath, {
    id: () => `note-${++id}`,
    now: () => "2026-07-16T12:00:00.000Z",
  });
  state.createNote({ body: "first" });
  state.createNote({ body: "second" });
  state.close();

  const tables = listTables(dbPath);
  const byName = new Map(tables.map((table) => [table.name, table]));
  assert.equal(byName.get("notes")?.rows, 2);
  assert.match(byName.get("notes")?.description ?? "", /worked example/i);
  assert.equal(byName.get("schema_migrations")?.rows, 1);
  assert.ok(byName.get("schema_migrations")?.description !== "(undocumented)");
  for (const table of tables) {
    assert.notEqual(table.description, "(undocumented)", `${table.name} has a table description`);
    assert.ok(
      describeTable(table.name, dbPath).columns.every((column) => column.description !== "(undocumented)"),
      `${table.name} has descriptions for every live column`,
    );
  }

  const notes = describeTable("notes", dbPath);
  assert.match(notes.description, /worked example/i);
  assert.deepEqual(notes.columns.map((column) => column.name), ["id", "body", "created_at", "updated_at"]);
  assert.ok(notes.columns.every((column) => column.description !== "(undocumented)"));
  assert.equal(notes.columns.find((column) => column.name === "id")?.primaryKey, true);
  assert.equal(notes.columns.find((column) => column.name === "body")?.notNull, true);
  assert.throws(() => describeTable("absent", dbPath), /no such table: absent/);

  const selected = runQuery("SELECT id, body FROM notes ORDER BY rowid", dbPath);
  assert.deepEqual(selected.rows.map((row) => row.body), ["first", "second"]);
  assert.equal(selected.truncated, false);

  const capped = runQuery(
    `WITH RECURSIVE n(i) AS (
       SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT ${QUERY_ROW_CAP + 5}
     ) SELECT i FROM n`,
    dbPath,
  );
  assert.equal(capped.rows.length, QUERY_ROW_CAP);
  assert.equal(capped.truncated, true);
  assert.doesNotThrow(() => runQuery(
    `WITH RECURSIVE n(i) AS (
       SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${QUERY_ROW_CAP + 5}
     )
     SELECT CASE WHEN i > ${QUERY_ROW_CAP + 1} THEN json_extract('not-json', '$') ELSE i END AS i FROM n`,
    dbPath,
  ), "query execution stops after fetching one truncation sentinel row");

  assert.throws(() => runQuery("DELETE FROM notes", dbPath), /read.?only|SQLITE_READONLY/i);
  assert.throws(
    () => runQuery("INSERT INTO notes (id, body, created_at, updated_at) VALUES ('x', 'x', 'x', 'x')", dbPath),
    /read.?only|SQLITE_READONLY/i,
  );
  assert.throws(() => runQuery("ATTACH '/tmp/elsewhere.db' AS elsewhere", dbPath), /ATTACH\/DETACH/);

  const drift = new DatabaseSync(dbPath);
  drift.exec("ALTER TABLE notes ADD COLUMN extra_detail TEXT");
  drift.exec("CREATE TABLE experimental_records (id TEXT PRIMARY KEY, detail TEXT)");
  drift.close();

  assert.equal(listTables(dbPath).find((table) => table.name === "experimental_records")?.description, "(undocumented)");
  const undocumentedTable = describeTable("experimental_records", dbPath);
  assert.equal(undocumentedTable.description, "(undocumented)");
  assert.ok(undocumentedTable.columns.every((column) => column.description === "(undocumented)"));
  assert.equal(
    describeTable("notes", dbPath).columns.find((column) => column.name === "extra_detail")?.description,
    "(undocumented)",
  );

  process.stdout.write("ok — read-only progressive database query\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
