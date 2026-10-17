import type { WorkspaceFile } from "./gateway-contracts";
import { nextAvailableName, pathJoin, pathName, pathParent } from "./workspace-paths";

export type EditorStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "clean"; readonly revision: string }
  | { readonly kind: "dirty"; readonly revision: string }
  | { readonly kind: "saving"; readonly revision: string }
  | { readonly kind: "error"; readonly revision: string; readonly message: string }
  | { readonly kind: "conflict"; readonly base: string; readonly disk: WorkspaceFile }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly message: string };

export interface EditorState {
  readonly path: string;
  /** Authoritative for display in every status. Never replaced without an explicit action. */
  readonly draft: string;
  readonly status: EditorStatus;
}

export type EditorAction =
  | { readonly kind: "loaded"; readonly file: WorkspaceFile }
  | { readonly kind: "edited"; readonly draft: string }
  | { readonly kind: "save-started" }
  | { readonly kind: "save-applied"; readonly revision: string }
  | { readonly kind: "save-conflicted"; readonly current: WorkspaceFile }
  | { readonly kind: "save-failed"; readonly message: string }
  | { readonly kind: "external"; readonly file: WorkspaceFile }
  | { readonly kind: "external-missing" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "keep-mine" }
  | { readonly kind: "keep-disk" }
  | { readonly kind: "keep-both" };

export function createEditorState(path: string): EditorState {
  return { path, draft: "", status: { kind: "loading" } };
}

/** The revision the draft was last based on, for the statuses that carry one. */
export function baseRevision(status: EditorStatus): string | undefined {
  switch (status.kind) {
    case "clean":
    case "dirty":
    case "saving":
    case "error":
      return status.revision;
    case "conflict":
      return status.base;
    default:
      return undefined;
  }
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { status } = state;
  switch (action.kind) {
    case "loaded":
      return { ...state, draft: action.file.content, status: { kind: "clean", revision: action.file.revision } };
    case "edited": {
      if (state.draft === action.draft) return state;
      // Typing is not a conflict resolution, and it cannot resurrect a deleted file.
      const locked = status.kind === "conflict" || status.kind === "missing" || status.kind === "loading" || status.kind === "unreadable";
      const next: EditorStatus = locked ? status : { kind: "dirty", revision: baseRevision(status) as string };
      return { ...state, draft: action.draft, status: next };
    }
    case "save-started":
      return status.kind === "dirty" || status.kind === "error"
        ? { ...state, status: { kind: "saving", revision: status.revision } }
        : state;
    case "save-applied":
      if (status.kind === "saving") return { ...state, status: { kind: "clean", revision: action.revision } };
      // The owner typed while the write was in flight: keep the edit and save again.
      if (status.kind === "dirty") return { ...state, status: { kind: "dirty", revision: action.revision } };
      return state;
    case "save-conflicted":
      if (status.kind !== "saving" && status.kind !== "dirty") return state;
      return { ...state, status: { kind: "conflict", base: status.revision, disk: action.current } };
    case "save-failed":
      if (status.kind !== "saving" && status.kind !== "dirty") return state;
      return { ...state, status: { kind: "error", revision: status.revision, message: action.message } };
    case "external": {
      const file = action.file;
      if (status.kind === "saving") return state;
      if (status.kind === "conflict") return { ...state, status: { kind: "conflict", base: status.base, disk: file } };
      if (status.kind === "loading" || status.kind === "unreadable") {
        return { ...state, draft: file.content, status: { kind: "clean", revision: file.revision } };
      }
      if (status.kind === "missing") {
        return state.draft === file.content
          ? { ...state, status: { kind: "clean", revision: file.revision } }
          : { ...state, status: { kind: "conflict", base: file.revision, disk: file } };
      }
      if (status.revision === file.revision) return state;
      if (status.kind === "clean") return { ...state, draft: file.content, status: { kind: "clean", revision: file.revision } };
      return { ...state, status: { kind: "conflict", base: status.revision, disk: file } };
    }
    case "external-missing":
      return status.kind === "missing" ? state : { ...state, status: { kind: "missing" } };
    case "unreadable":
      return { ...state, status: { kind: "unreadable", message: action.message } };
    case "keep-mine":
      return status.kind === "conflict" ? { ...state, status: { kind: "dirty", revision: status.disk.revision } } : state;
    case "keep-disk":
    case "keep-both":
      return status.kind === "conflict"
        ? { ...state, draft: status.disk.content, status: { kind: "clean", revision: status.disk.revision } }
        : state;
  }
}

export function saveIndicator(status: EditorStatus): "Saving" | "Saved" | "Unsaved" | "Conflict" | "Error" {
  switch (status.kind) {
    case "loading":
    case "saving":
      return "Saving";
    case "clean":
      return "Saved";
    case "dirty":
      return "Unsaved";
    case "conflict":
      return "Conflict";
    default:
      return "Error";
  }
}

/**
 * Where Keep both writes the owner's draft: a free `<stem> (my copy).md` beside the file, so
 * neither version is written over the other.
 */
export function keepBothPath(path: string, siblingNames: Iterable<string>): string {
  const stem = pathName(path).replace(/\.md$/i, "");
  return pathJoin(pathParent(path), nextAvailableName(siblingNames, `${stem} (my copy)`, ".md"));
}
