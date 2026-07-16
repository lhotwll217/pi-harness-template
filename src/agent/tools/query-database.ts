import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { QueryResult, TableDescription, TableInfo } from "../../state/query";

/** Read-only State query seam injected by the daemon composition root. */
export interface DatabaseQueryInterface {
  listTables(): TableInfo[];
  describeTable(table: string): TableDescription;
  runQuery(sql: string): QueryResult;
}

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  details: undefined,
});

/** Progressive disclosure: catalog first, schema second, bounded SELECT last. */
export function createQueryDatabaseTool(query: DatabaseQueryInterface) {
  return defineTool({
    name: "query_database",
    label: "Query harness database",
    description:
      "Inspect the harness state database through a read-only interface. Start with list_tables, " +
      "then describe_table, then use query for a bounded SELECT (maximum 200 rows).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list_tables"),
        Type.Literal("describe_table"),
        Type.Literal("query"),
      ]),
      table: Type.Optional(Type.String({ description: "Table name for describe_table." })),
      sql: Type.Optional(Type.String({ description: "SELECT statement for query." })),
    }),
    async execute(_id, params) {
      if (params.action === "list_tables") return textResult(query.listTables());
      if (params.action === "describe_table") {
        if (!params.table?.trim()) throw new Error("describe_table needs a table name");
        return textResult(query.describeTable(params.table));
      }
      if (!params.sql?.trim()) throw new Error("query needs a SQL SELECT statement");
      return textResult(query.runQuery(params.sql));
    },
  });
}

