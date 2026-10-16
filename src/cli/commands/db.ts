import type { Command } from "commander";
import { DatabaseQueryAction } from "@pi-template/contracts";
import type { QueryResult } from "../../state/query";
import { emit, noun, verb, withGateway } from "./command";

const TRUNCATED_HINT = "add WHERE or LIMIT, select fewer or shorter columns, or aggregate with count(*) and GROUP BY";

export function addDb(program: Command): void {
  const db = noun(program, "db", "read-only SQL over the harness's state database", {
    useWhen: "a question asks how many, which, or since when about notes, schedules, or schedule runs.",
    notFor: "how the harness works (pi-template docs), or changing data (the noun that owns it, e.g. pi-template notes).",
    next: "pi-template db tables, then pi-template db describe <table>, then pi-template db query '<SELECT>'.",
    rules: [
      "Never guess a table or column: describe it first.",
      "Put the SQL in single quotes.",
      "Let the database count: prefer count(*) and GROUP BY to reading rows.",
    ],
    examples: [
      "pi-template db tables",
      "pi-template db describe schedule_runs",
      "pi-template db query 'SELECT status, count(*) FROM schedule_runs GROUP BY status'",
    ],
  });

  verb(db, "tables", "every table with its row count and what it holds", {
    useWhen: "you start on a data question and need to know which table holds the answer.",
    next: "pi-template db describe <table> for its columns.",
    examples: ["pi-template db tables"],
  }, async () => await withGateway(async (client) => {
    await emit(await client.queryDatabase({ action: DatabaseQueryAction.ListTables }));
    return 0;
  }));

  verb(db, "describe <table>", "a table's columns with their types and meaning", {
    useWhen: "you know the table and need its column names or what they hold.",
    next: "pi-template db query '<SELECT>' using those columns.",
    examples: ["pi-template db describe notes", "pi-template db describe schedule_runs"],
  }, async ({ args: [table] }) => await withGateway(async (client) => {
    await emit(await client.queryDatabase({ action: DatabaseQueryAction.DescribeTable, table: table as string }));
    return 0;
  }));

  verb(db, "query <sql>", "run one read-only SELECT; results are capped and flag truncation", {
    useWhen: "you know the table and columns (from describe) and want rows, counts, or joins.",
    notFor: "guessing names: run pi-template db describe <table> first.",
    rules: [
      "Reads only: any write, ATTACH, PRAGMA, or VACUUM is refused and the data is left unchanged.",
      "One statement per call; SQL after the first statement is refused.",
      "At most 200 rows or 1 MB come back, and a cut result says so: narrow it with WHERE or LIMIT, or aggregate.",
      "A query stops after 5 s.",
      "Prints { rows, truncated }; a cut result adds a hint on narrowing it.",
    ],
    examples: [
      "pi-template db query 'SELECT count(*) FROM notes'",
      "pi-template db query 'SELECT id, status, finished_at FROM schedule_runs ORDER BY created_at DESC LIMIT 10'",
    ],
  }, async ({ args: [sql] }) => await withGateway(async (client) => {
    const result = await client.queryDatabase({ action: DatabaseQueryAction.Query, sql: sql as string }) as QueryResult;
    await emit(result.truncated ? { ...result, hint: TRUNCATED_HINT } : result);
    return 0;
  }));
}
