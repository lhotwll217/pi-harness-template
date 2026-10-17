import type { WorkspaceFile, WorkspaceTree, WorkspaceWriteResult } from "./gateway-contracts";

export class LocalRouteError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = "LocalRouteError";
  }
}

/** The app's routes answer `{ error: { message } }`; anything else is reduced to one safe sentence. */
export function ownerSafeMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() && message.length <= 500 ? message : fallback;
}

export async function callLocalRoute<T>(path: string, fallback: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new LocalRouteError(503, "The app is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) throw new LocalRouteError(response.status, ownerSafeMessage(body, fallback), body);
  return body as T;
}

export const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchWorkspaceTree(signal?: AbortSignal): Promise<WorkspaceTree> {
  return callLocalRoute<WorkspaceTree>("/api/workspace/tree", "The app could not read the files.", signal ? { signal } : undefined);
}

const fileRoute = (path: string): string => `/api/workspace/file?path=${encodeURIComponent(path)}`;

export async function fetchWorkspaceFile(path: string, signal?: AbortSignal): Promise<WorkspaceFile> {
  return callLocalRoute<WorkspaceFile>(fileRoute(path), "The app could not read that file.", signal ? { signal } : undefined);
}

/** What a save came back with: written, or refused because the file changed since `baseRevision`. */
export type WriteOutcome =
  | { readonly kind: "written"; readonly result: WorkspaceWriteResult }
  | { readonly kind: "conflict"; readonly current: WorkspaceFile };

export async function writeWorkspaceFile(path: string, content: string, baseRevision?: string): Promise<WriteOutcome> {
  try {
    const result = await callLocalRoute<WorkspaceWriteResult>(
      fileRoute(path),
      "The app could not save that file.",
      jsonBody("PUT", baseRevision ? { content, baseRevision } : { content }),
    );
    return { kind: "written", result };
  } catch (error: unknown) {
    const current = error instanceof LocalRouteError && error.status === 409
      ? (error.body as { current?: WorkspaceFile } | undefined)?.current
      : undefined;
    if (current) return { kind: "conflict", current };
    throw error;
  }
}
