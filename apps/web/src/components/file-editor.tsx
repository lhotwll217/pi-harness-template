"use client";

import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { fetchWorkspaceFile, LocalRouteError, writeWorkspaceFile } from "@/lib/workspace-client";
import {
  createEditorState,
  editorReducer,
  keepBothPath,
  saveIndicator,
  type EditorAction,
  type EditorState,
} from "@/lib/workspace-editor";
import { pathName } from "@/lib/workspace-paths";

export const AUTOSAVE_DELAY_MS = 750;

const SAVE_FAILED = "The app could not save that file.";
export const NOT_TEXT = "Not a text file. The editor opens UTF-8 text only.";

export interface FileEditorProps {
  readonly path: string;
  /** Bumped by the shell whenever workspace truth may have changed, which re-reads the file. */
  readonly invalidationToken: number;
  /** Names beside this file, so Keep both picks one that is free. */
  readonly siblingNames: readonly string[];
  readonly onBackToChat: () => void;
  readonly onFileCreated: (path: string) => void;
}

const badgeTone: Record<string, string> = {
  Saving: "text-muted-foreground",
  Saved: "text-muted-foreground",
  Unsaved: "text-amber-600 dark:text-amber-500",
  Conflict: "text-destructive",
  Error: "text-destructive",
};

export function FileEditor({ path, invalidationToken, siblingNames, onBackToChat, onFileCreated }: FileEditorProps) {
  const [state, dispatch] = useReducer(editorReducer, path, createEditorState);
  const [actionError, setActionError] = useState<string>();
  const [saveTick, setSaveTick] = useState(0);
  const stateRef = useRef<EditorState>(state);
  const writeRef = useRef<Promise<void> | undefined>(undefined);
  const pendingRef = useRef(false);
  const firstReadRef = useRef(true);

  const apply = useCallback((action: EditorAction) => {
    stateRef.current = editorReducer(stateRef.current, action);
    dispatch(action);
  }, []);

  const indicator = saveIndicator(state.status);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const file = await fetchWorkspaceFile(path);
        if (cancelled) return;
        apply(firstReadRef.current ? { kind: "loaded", file } : { kind: "external", file });
        firstReadRef.current = false;
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof LocalRouteError && error.status === 404) apply({ kind: "external-missing" });
        else if (error instanceof LocalRouteError && error.status === 415) apply({ kind: "unreadable", message: NOT_TEXT });
        else setActionError(error instanceof Error ? error.message : "The app could not read that file.");
      }
    })();
    return () => { cancelled = true; };
  }, [apply, invalidationToken, path]);

  const writeDraft = useCallback(async () => {
    const current = stateRef.current;
    const status = current.status;
    if (status.kind !== "dirty" && status.kind !== "error") return;
    apply({ kind: "save-started" });
    try {
      const outcome = await writeWorkspaceFile(current.path, current.draft, status.revision);
      if (outcome.kind === "written") apply({ kind: "save-applied", revision: outcome.result.revision });
      else apply({ kind: "save-conflicted", current: outcome.current });
    } catch (error: unknown) {
      apply({ kind: "save-failed", message: error instanceof Error ? error.message : SAVE_FAILED });
    }
  }, [apply]);

  const save = useCallback(async (): Promise<void> => {
    while (writeRef.current) {
      pendingRef.current = true;
      await writeRef.current;
    }
    const kind = stateRef.current.status.kind;
    if (kind !== "dirty" && kind !== "error") return;
    const pass = (async () => {
      do {
        pendingRef.current = false;
        await writeDraft();
      } while (pendingRef.current);
    })();
    writeRef.current = pass;
    try {
      await pass;
    } finally {
      writeRef.current = undefined;
      pendingRef.current = false;
      setSaveTick((tick) => tick + 1);
    }
  }, [writeDraft]);

  useEffect(() => {
    const kind = state.status.kind;
    if ((kind !== "dirty" && kind !== "error") || writeRef.current) return;
    const timer = window.setTimeout(() => { void save(); }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [save, saveTick, state.draft, state.status]);

  const flushRef = useRef<() => void>(() => undefined);
  useEffect(() => { flushRef.current = () => { void save(); }; }, [save]);
  useEffect(() => () => flushRef.current(), []);

  const keepBoth = useCallback(async () => {
    const copy = keepBothPath(stateRef.current.path, siblingNames);
    setActionError(undefined);
    try {
      await writeWorkspaceFile(copy, stateRef.current.draft);
      apply({ kind: "keep-both" });
      onFileCreated(copy);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "The app could not keep both versions.");
    }
  }, [apply, onFileCreated, siblingNames]);

  const crumbs = useMemo(() => path.split("/").slice(0, -1), [path]);
  const editable = state.status.kind !== "loading" && state.status.kind !== "unreadable";

  return (
    <section aria-label="File editor" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
        <Button aria-label="Back to chat" onClick={onBackToChat} size="icon-sm" variant="ghost"><ArrowLeftIcon /></Button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span>Files</span>
          {crumbs.map((crumb) => <span className="truncate" key={crumb}><span aria-hidden className="px-1">/</span>{crumb}</span>)}
        </nav>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{pathName(path)}</h1>
        <span className={cn("text-xs", badgeTone[indicator])} data-slot="save-indicator" role="status">{indicator}</span>
      </header>

      {actionError && <p className="border-b bg-destructive/5 px-4 py-2 text-sm text-destructive sm:px-6" role="alert">{actionError}</p>}

      {state.status.kind === "unreadable" && (
        <p className="border-b bg-muted/50 px-4 py-3 text-sm sm:px-6" role="alert">{state.status.message}</p>
      )}

      {state.status.kind === "missing" && (
        <div className="border-b bg-muted/50 px-4 py-3 text-sm sm:px-6" role="alert">
          <p className="font-medium">This file is no longer in the files folder.</p>
          <p className="mt-1 text-muted-foreground">Your text is still here. Copy anything you need, then go back.</p>
          <Button className="mt-2" onClick={onBackToChat} size="sm" variant="outline">Back to chat</Button>
        </div>
      )}

      {state.status.kind === "error" && (
        <div className="border-b bg-destructive/5 px-4 py-3 text-sm sm:px-6" role="alert">
          <p className="font-medium text-destructive">{state.status.message}</p>
          <p className="mt-1 text-muted-foreground">Your text is still here. The editor keeps trying while this file is open.</p>
          <Button className="mt-2" onClick={() => void save()} size="sm" variant="outline">Try again</Button>
        </div>
      )}

      {state.status.kind === "conflict" && (
        <div className="border-b bg-amber-500/10 px-4 py-3 sm:px-6" role="alert">
          <p className="text-sm font-medium">This file changed on disk while you were editing.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Your version</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border bg-background p-2 font-mono text-xs">{state.draft}</pre>
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">On disk</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border bg-background p-2 font-mono text-xs">{state.status.disk.content}</pre>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => apply({ kind: "keep-mine" })} size="sm">Keep mine</Button>
            <Button onClick={() => apply({ kind: "keep-disk" })} size="sm" variant="outline">Keep disk</Button>
            <Button onClick={() => void keepBoth()} size="sm" variant="outline">Keep both</Button>
          </div>
        </div>
      )}

      <Textarea
        aria-label="File text"
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 shadow-none focus-visible:ring-0 sm:px-6"
        disabled={!editable}
        onBlur={() => void save()}
        onChange={(event) => apply({ kind: "edited", draft: event.target.value })}
        placeholder="Write Markdown here."
        spellCheck={false}
        value={state.draft}
      />
    </section>
  );
}
