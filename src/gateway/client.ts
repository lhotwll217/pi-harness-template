import { readFileSync } from "node:fs";
import {
  harnessPaths,
  type DaemonHealth,
  type DaemonInfo,
  type DaemonReady,
  type GatewayEvent,
} from "@pi-template/contracts";

/** Authenticated health, readiness, and event transport for the live daemon. */
export interface GatewayClient {
  health(): Promise<DaemonHealth>;
  ready(): Promise<DaemonReady>;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
  close(): void;
}

function readDaemonInfo(): DaemonInfo | null {
  try { return JSON.parse(readFileSync(harnessPaths().daemonInfo, "utf8")) as DaemonInfo; } catch { return null; }
}

async function gatewayJson<T>(
  info: DaemonInfo,
  path: string,
  acceptStatuses: readonly number[] = [],
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    headers: { authorization: `Bearer ${info.authToken}` },
  });
  if (!response.ok && !acceptStatuses.includes(response.status)) {
    throw new Error(`Gateway ${path}: ${response.status}`);
  }
  return await response.json() as T;
}

/** Connect to an authenticated live daemon, including one not yet fully ready. */
export async function connectGateway(): Promise<GatewayClient | null> {
  const info = readDaemonInfo();
  if (!info?.authToken) return null;
  try {
    const health = await gatewayJson<DaemonHealth>(info, "/health");
    await gatewayJson<DaemonReady>(info, "/ready", [503]);
    if (health.pid !== info.pid || health.fingerprint !== info.fingerprint) return null;
  } catch {
    return null;
  }

  const subscriptions = new Set<() => void>();
  return {
    health: () => gatewayJson<DaemonHealth>(info, "/health"),
    ready: () => gatewayJson<DaemonReady>(info, "/ready", [503]),
    subscribe(listener) {
      const controller = new AbortController();
      const stop = (): void => {
        controller.abort();
        subscriptions.delete(stop);
      };
      subscriptions.add(stop);

      void (async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${info.port}/events`, {
            headers: { authorization: `Bearer ${info.authToken}` },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Gateway /events: ${response.status}`);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Gateway event stream has no body");
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                try { listener(JSON.parse(line.slice(6)) as GatewayEvent); } catch { /* malformed frame */ }
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        } catch {
          // Closing the client aborts the event stream.
        }
      })();
      return stop;
    },
    close() {
      for (const stop of subscriptions) stop();
    },
  };
}
