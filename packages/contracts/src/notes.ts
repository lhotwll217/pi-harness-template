// The worked-example record family (docs/state-and-sessions.md#worked-example-notes).
// Deliberately trivial: it exists to demonstrate the write-to-read pattern — one State
// method, two callers (the notes CLI via the Gateway and the save_note agent tool) — and
// is meant to be deleted by products that copy the pattern for real record families.

export interface Note {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteCreateInput {
  body: string;
}
