import type { Command } from "commander";
import { emit, noun, verb, withGateway } from "./command";

export function addDocs(program: Command): void {
  const docs = noun(program, "docs", "the harness's own documentation: list pages, read one, or ask which to read", {
    useWhen: "a question is about how this harness works or why it was built this way.",
    notFor: "the harness's data: pi-template db.",
    next: "pi-template docs query \"<question>\", then pi-template docs read <id> for each id in its readingPlan.",
    examples: ['pi-template docs query "how do schedules work"', "pi-template docs read scheduler"],
  });

  verb(docs, "list", "every page with its summary and read-when hints", {
    useWhen: "you want to browse the pages rather than ask a question.",
    next: "pi-template docs read <id>.",
    examples: ["pi-template docs list"],
  }, async () => await withGateway(async (client) => {
    await emit(await client.listDocs());
    return 0;
  }));

  verb(docs, "read <id>", "one page's Markdown", {
    useWhen: "docs query or docs list named the page that owns your question.",
    examples: ["pi-template docs read scheduler"],
  }, async ({ args: [id] }) => await withGateway(async (client) => {
    await emit(await client.readDocs(id as string));
    return 0;
  }));

  verb(docs, "query <question...>", "pages ranked for a question, and the order to read them in", {
    useWhen: "you have a question about the harness and do not know which page answers it.",
    next: "pi-template docs read <id> for each id in readingPlan.",
    examples: ['pi-template docs query "how do schedules work"'],
  }, async ({ args: [question] }) => await withGateway(async (client) => {
    await emit(await client.queryDocs((question as string[]).join(" ")));
    return 0;
  })).passThroughOptions().allowUnknownOption();
}
