import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { State } from "./state";
import { DatabaseQueryError, describeTable, listTables, QUERY_ROW_CAP, QUERY_TIME_LIMIT_MS, runQuery } from "./query";

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
  assert.throws(() => describeTable("note", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.deepEqual(error.closest, ["notes"]);
    return true;
  });

  const selected = await runQuery("SELECT id, body FROM notes ORDER BY rowid", dbPath);
  assert.deepEqual(selected.rows.map((row) => row.body), ["first", "second"]);
  assert.equal(selected.truncated, false);

  const capped = await runQuery(
    `WITH RECURSIVE n(i) AS (
       SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT ${QUERY_ROW_CAP + 5}
     ) SELECT i FROM n`,
    dbPath,
  );
  assert.equal(capped.rows.length, QUERY_ROW_CAP);
  assert.equal(capped.truncated, true);
  await assert.doesNotReject(runQuery(
    `WITH RECURSIVE n(i) AS (
       SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${QUERY_ROW_CAP + 5}
     )
     SELECT CASE WHEN i > ${QUERY_ROW_CAP + 1} THEN json_extract('not-json', '$') ELSE i END AS i FROM n`,
    dbPath,
  ), "query execution stops after fetching one truncation sentinel row");

  for (const sql of [
    "DELETE FROM notes",
    "UPDATE notes SET body = 'x'",
    "INSERT INTO notes (id, body, created_at, updated_at) VALUES ('x', 'x', 'x', 'x')",
    "ATTACH '/tmp/elsewhere.db' AS elsewhere",
    "PRAGMA table_info(notes)",
  ]) {
    await assert.rejects(runQuery(sql, dbPath), (error: unknown) => {
      assert.ok(error instanceof DatabaseQueryError);
      assert.equal(error.message, "not authorized", sql);
      return true;
    });
  }
  assert.deepEqual(
    (await runQuery("SELECT id, body FROM notes ORDER BY rowid", dbPath)).rows,
    [{ id: "note-1", body: "first" }, { id: "note-2", body: "second" }],
    "refused writes leave the data unchanged",
  );

  await assert.rejects(runQuery("SELECT body FROM note", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, "no such table: note");
    assert.deepEqual(error.closest, ["notes"]);
    return true;
  });

  const started = Date.now();
  await assert.rejects(
    runQuery("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n", dbPath),
    /query stopped after 5 s/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= QUERY_TIME_LIMIT_MS && elapsed < QUERY_TIME_LIMIT_MS + 1_000, `runaway query stopped after ${elapsed} ms`);

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
