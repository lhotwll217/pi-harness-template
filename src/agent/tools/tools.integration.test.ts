import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../../state";
import { describeTable, listTables, runQuery } from "../../state/query";
import { createQueryDatabaseTool } from "./query-database";
import { createSaveNoteTool } from "./save-note";

const dir = mkdtempSync(join(tmpdir(), "pi-template-agent-tools-"));
const dbPath = join(dir, "state.db");

const execute = async (
  tool: { execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }> },
  input: Record<string, unknown>,
): Promise<unknown> => {
  const result = await tool.execute("call-1", input, undefined, undefined, undefined);
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text);
};

try {
  let id = 0;
  const state = new State(dbPath, {
    id: () => `note-${++id}`,
    now: () => "2026-07-16T12:00:00.000Z",
  });
  const query = createQueryDatabaseTool({
    listTables: () => listTables(dbPath),
    describeTable: (table) => describeTable(table, dbPath),
    runQuery: (sql) => runQuery(sql, dbPath),
  });
  const save = createSaveNoteTool({ createNote: (input) => state.createNote(input) });

  const listed = await execute(query, { action: "list_tables" }) as Array<{ name: string }>;
  assert.ok(listed.some(({ name }) => name === "notes"));

  const described = await execute(query, { action: "describe_table", table: "notes" }) as {
    columns: Array<{ name: string }>;
  };
  assert.deepEqual(described.columns.map(({ name }) => name), ["id", "body", "created_at", "updated_at"]);
  await assert.rejects(execute(query, { action: "describe_table" }), /table name/i);
  await assert.rejects(execute(query, { action: "query" }), /sql select/i);

  const note = await execute(save, { body: "Visible through the durable query seam" }) as { id: string };
  assert.equal(note.id, "note-1");
  const selected = await execute(query, {
    action: "query",
    sql: "SELECT id, body FROM notes ORDER BY created_at",
  }) as { rows: Array<{ id: string; body: string }>; truncated: boolean };
  assert.deepEqual(selected, {
    rows: [{ id: "note-1", body: "Visible through the durable query seam" }],
    truncated: false,
  });
  assert.deepEqual(state.listNotes().map(({ body }) => body), ["Visible through the durable query seam"]);
  state.close();

  process.stdout.write("ok — injected agent tools persist and disclose durable state progressively\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
