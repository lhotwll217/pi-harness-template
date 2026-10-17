import * as chat from "@/app/api/chats/[id]/route";
import * as cancel from "@/app/api/chats/[id]/cancel/route";
import * as messages from "@/app/api/chats/[id]/messages/route";
import * as chats from "@/app/api/chats/route";
import * as status from "@/app/api/status/route";
import * as file from "@/app/api/workspace/file/route";
import * as tree from "@/app/api/workspace/tree/route";
import { localRequest, routeParams } from "./fake-gateway";

type Handler = (request: Request, context: ReturnType<typeof routeParams>) => Promise<Response>;
type RouteModule = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;

const ROUTES: ReadonlyArray<readonly [RegExp, RouteModule]> = [
  [/^\/api\/status$/, status],
  [/^\/api\/chats$/, chats],
  [/^\/api\/chats\/([^/]+)$/, chat as RouteModule],
  [/^\/api\/chats\/([^/]+)\/messages$/, messages as RouteModule],
  [/^\/api\/chats\/([^/]+)\/cancel$/, cancel as RouteModule],
  [/^\/api\/workspace\/tree$/, tree],
  [/^\/api\/workspace\/file$/, file],
];

export interface AppCall {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

export function appFetch(realFetch: typeof fetch, calls: AppCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/api/")) return await realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const { pathname } = new URL(url, "http://127.0.0.1:47812");
    for (const [pattern, route] of ROUTES) {
      const match = pattern.exec(pathname);
      const handler = match && route[method as keyof RouteModule];
      if (!handler) continue;
      return await handler(localRequest(url, { ...init, method }), routeParams(decodeURIComponent(match[1] ?? "")));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** Stands in for the browser's EventSource; a test delivers frames with `emit`. */
export class StubEventSource {
  static instances: StubEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly named = new Map<string, Array<() => void>>();
  constructor(readonly url: string) { StubEventSource.instances.push(this); }
  addEventListener(name: string, listener: () => void): void {
    this.named.set(name, [...(this.named.get(name) ?? []), listener]);
  }
  close(): void {}
  emit(event: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  emitNamed(name: string): void {
    for (const listener of this.named.get(name) ?? []) listener();
  }
}

export class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
