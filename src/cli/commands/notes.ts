import type { Command } from "commander";
import { emit, noun, verb, withGateway } from "./command";

export function addNotes(program: Command): void {
  const notes = noun(program, "notes", "the worked-example record family: add, list, and remove notes", {
    useWhen: "you want to keep a short note in durable state, or see the ones kept.",
    notFor: "counting or filtering notes: pi-template db query.",
    next: "pi-template notes list to see ids, pi-template notes remove <id> to delete one.",
    examples: ['pi-template notes add "renew the certificate"', "pi-template notes list"],
  });

  verb(notes, "add <body...>", "save a note", {
    examples: ['pi-template notes add "renew the certificate"'],
  }, async ({ args: [body] }) => await withGateway(async (client) => {
    await emit(await client.createNote({ body: (body as string[]).join(" ") }));
    return 0;
  }));

  verb(notes, "list", "every note, newest first", {
    examples: ["pi-template notes list"],
  }, async () => await withGateway(async (client) => {
    await emit(await client.listNotes());
    return 0;
  }));

  verb(notes, "remove <id>", "delete a note", {
    examples: ["pi-template notes remove <id from notes list>"],
  }, async ({ args: [id] }) => await withGateway(async (client) => {
    await client.deleteNote(id as string);
    await emit({ ok: true });
    return 0;
  }));
}
