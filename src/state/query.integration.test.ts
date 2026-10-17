import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { State } from "./state";
import {
  DatabaseQueryError,
  describeTable,
  listTables,
  QUERY_BYTE_CAP,
  QUERY_ROW_CAP,
  QUERY_TIME_LIMIT_MS,
  runQuery,
} from "./query";
import { SCHEMA_DOCS } from "./schema-docs";

const READ_ONLY_HINT = "`pi-template db query` runs one read-only SELECT against the state database.";
const RUNAWAY = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n";
const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const queryProcessOf = async (parent: number): Promise<number> => {
  for (const deadline = Date.now() + 10_000; ;) {
    const found = spawnSync("pgrep", ["-P", String(parent), "-f", "node:sqlite"], { encoding: "utf8" }).stdout.trim();
    if (found) return Number(found.split("\n")[0]);
    if (Date.now() > deadline) throw new Error("the query process never started");
    await delay(20);
  }
};

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
  assert.equal(byName.get("schema_migrations")?.rows, 2);
  assert.ok(byName.get("schema_migrations")?.description !== "(undocumented)");
  for (const table of tables) {
    assert.notEqual(table.description, "(undocumented)", `${table.name} has a table description`);
    assert.ok(
      describeTable(table.name, dbPath).columns.every((column) => column.description !== "(undocumented)"),
      `${table.name} has descriptions for every live column`,
    );
  }
  const liveColumns = new Map(tables.map((table) => [
    table.name,
    describeTable(table.name, dbPath).columns.map((column) => column.name).sort(),
  ]));
  for (const doc of SCHEMA_DOCS) {
    assert.deepEqual(
      doc.columns.map((column) => column.name).sort(),
      liveColumns.get(doc.name),
      `every table and column SCHEMA_DOCS describes for ${doc.name} is in the live schema`,
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
  const beforeRefusals = fileHash(dbPath);
  const vacuumTarget = join(dir, "copy.db");
  for (const sql of [
    "DELETE FROM notes",
    "ATTACH '/tmp/elsewhere.db' AS elsewhere",
    "VACUUM",
    `VACUUM INTO '${vacuumTarget}'`,
    "SELECT load_extension('/tmp/missing-extension')",
  ]) {
    await assert.rejects(runQuery(sql, dbPath), (error: unknown) => {
      assert.ok(error instanceof DatabaseQueryError);
      assert.equal(error.hint, READ_ONLY_HINT, sql);
      return true;
    });
  }
  assert.equal(existsSync(vacuumTarget), false, "VACUUM INTO writes no copy");
  assert.equal(fileHash(dbPath), beforeRefusals, "refused statements leave the database file unchanged");
  assert.deepEqual(
    (await runQuery("SELECT id, body FROM notes ORDER BY rowid", dbPath)).rows,
    [{ id: "note-1", body: "first" }, { id: "note-2", body: "second" }],
    "refused writes leave the data unchanged",
  );

  await assert.rejects(runQuery("SELECT 1; DELETE FROM notes", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, "db query runs one statement; found more after the first");
    assert.equal(error.hint, "Send each statement in its own `pi-template db query`.");
    return true;
  });
  assert.equal(fileHash(dbPath), beforeRefusals, "a trailing statement never runs");
  assert.deepEqual((await runQuery("SELECT 1 AS one;", dbPath)).rows, [{ one: 1 }]);
  assert.deepEqual((await runQuery("SELECT 1 AS one; -- done\n/* really */ ;", dbPath)).rows, [{ one: 1 }]);

  const wide = await runQuery(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 10)
     SELECT printf('%.*c', 200000, 'x') AS x FROM n`,
    dbPath,
  );
  assert.equal(wide.rows.length, 4, "rows stop before the byte cap");
  assert.equal(wide.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= QUERY_BYTE_CAP);

  for (const sql of ["", "  ", "-- only a comment", ";"]) {
    await assert.rejects(runQuery(sql, dbPath), (error: unknown) => {
      assert.ok(error instanceof DatabaseQueryError);
      assert.equal(error.message, "db query runs one statement; found none", JSON.stringify(sql));
      assert.equal(error.hint, READ_ONLY_HINT);
      return true;
    });
  }
  await assert.rejects(runQuery("SELECT 9007199254740993 AS big", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, "Value is too large to be represented as a JavaScript number: 9007199254740993");
    assert.equal(error.hint, "Select an integer beyond 2^53 as text: CAST(<column> AS TEXT).");
    return true;
  });
  await assert.rejects(runQuery("SELEC 1", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, 'near "SELEC": syntax error');
    assert.equal(error.hint, undefined, "no hint fits a syntax error");
    return true;
  });
  assert.deepEqual(
    await runQuery("SELECT zeroblob(140000000) AS b", dbPath),
    { rows: [], truncated: true },
    "a value over the byte cap cuts the result before it is serialized",
  );

  await assert.rejects(runQuery("SELECT body FROM note", dbPath), (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, "no such table: note");
    assert.deepEqual(error.closest, ["notes"]);
    return true;
  });

  const started = Date.now();
  await assert.rejects(runQuery(RUNAWAY, dbPath), /query stopped after 5 s/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= QUERY_TIME_LIMIT_MS && elapsed < QUERY_TIME_LIMIT_MS + 1_000, `runaway query stopped after ${elapsed} ms`);

  const killed = runQuery(RUNAWAY, dbPath);
  process.kill(await queryProcessOf(process.pid), "SIGKILL");
  await assert.rejects(killed, (error: unknown) => {
    assert.ok(error instanceof DatabaseQueryError);
    assert.equal(error.message, "the query process was killed by SIGKILL", "only the time limit reads as the time limit");
    return true;
  });

  const stalledStarted = Date.now();
  const stalled = runQuery(RUNAWAY, dbPath);
  const stalledProcess = await queryProcessOf(process.pid);
  process.kill(stalledProcess, "SIGSTOP");
  const stalledOutcome = await Promise.race([
    stalled.then(() => "resolved", (error: unknown) => error),
    delay(QUERY_TIME_LIMIT_MS + 3_000).then(() => "still running"),
  ]);
  if (alive(stalledProcess)) process.kill(stalledProcess, "SIGKILL");
  assert.match(String(stalledOutcome instanceof Error ? stalledOutcome.message : stalledOutcome), /query stopped after 5 s/);
  const stalledElapsed = Date.now() - stalledStarted;
  assert.ok(
    stalledElapsed >= QUERY_TIME_LIMIT_MS + 1_000 && stalledElapsed < QUERY_TIME_LIMIT_MS + 2_000,
    `a query process whose guard cannot fire stops after ${stalledElapsed} ms`,
  );

  const caller = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    `import { runQuery } from ${JSON.stringify(fileURLToPath(new URL("./query.ts", import.meta.url)))};
     await runQuery(${JSON.stringify(RUNAWAY)}, ${JSON.stringify(dbPath)});`,
  ], { stdio: "ignore" });
  let queryProcess: number | undefined;
  for (const deadline = Date.now() + 10_000; queryProcess === undefined;) {
    const found = spawnSync("pgrep", ["-P", String(caller.pid)], { encoding: "utf8" }).stdout.trim();
    if (found) queryProcess = Number(found.split("\n")[0]);
    else if (Date.now() > deadline) throw new Error("the query process never started");
    else await delay(20);
  }
  const queryStarted = Date.now();
  await delay(1_000);
  caller.kill("SIGKILL");
  while (alive(queryProcess) && Date.now() - queryStarted < QUERY_TIME_LIMIT_MS + 1_000) await delay(50);
  const orphaned = alive(queryProcess);
  if (orphaned) process.kill(queryProcess, "SIGKILL");
  assert.equal(orphaned, false, "a runaway query stops at the time limit even after its caller is killed");

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
