import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  DEFAULT_DAEMON_PORT,
  type DaemonHealth,
  type DaemonReady,
} from "@pi-template/contracts";

export interface GatewayOptions {
  authToken: string;
  health: () => DaemonHealth;
  ready: () => DaemonReady;
  port?: number;
}

export interface RunningGateway {
  host: "127.0.0.1";
  port: number;
  close(): Promise<void>;
}

function hasValidAuthorization(header: string | undefined, authToken: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${authToken}`));
}

function listenPort(override: number | undefined): number {
  if (override !== undefined) return override;
  if (process.env.PI_TEMPLATE_PORT === undefined) return DEFAULT_DAEMON_PORT;
  const raw = process.env.PI_TEMPLATE_PORT.trim();
  if (!raw) throw new Error("PI_TEMPLATE_PORT must not be blank");
  const configured = Number(raw);
  if (!Number.isInteger(configured) || configured < 0 || configured > 65_535) {
    throw new Error("PI_TEMPLATE_PORT must be an integer from 0 through 65535");
  }
  return configured;
}

/** Loopback transport only: behavior is supplied through public contract seams. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const streams = new Set<ServerResponse>();
  const server: Server = createServer((request, response) => {
    const respond = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (!hasValidAuthorization(request.headers.authorization, options.authToken)) {
      response.setHeader("www-authenticate", "Bearer");
      return respond(401, { error: "unauthorized" });
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /health") return respond(200, options.health());
    if (route === "GET /ready") {
      const readiness = options.ready();
      return respond(readiness.ready ? 200 : 503, readiness);
    }
    if (route === "GET /events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(":ready\n\n");
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    return respond(404, { error: "unknown route" });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort(options.port), "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    host: "127.0.0.1",
    port,
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
