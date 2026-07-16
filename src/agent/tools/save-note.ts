import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { Note, NoteCreateInput } from "@pi-template/contracts";

/** The same State writer used by the notes CLI surface. */
export interface NoteWriter {
  createNote(input: NoteCreateInput): Note;
}

export function createSaveNoteTool(notes: NoteWriter) {
  return defineTool({
    name: "save_note",
    label: "Save note",
    description: "Persist a note in harness state so it is available through the read-only query surface.",
    parameters: Type.Object({
      body: Type.String({ minLength: 1, description: "The note body to persist." }),
    }),
    async execute(_id, params) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(notes.createNote({ body: params.body }), null, 2) }],
        details: undefined,
      };
    },
  });
}
