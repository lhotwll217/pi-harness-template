export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export class LocalRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LocalRequestError";
  }
}

/**
 * `read` is a GET. A `json` mutation carries a JSON body, which no cross-site form can send
 * without a preflight. A `bodiless` mutation (DELETE) is never a simple request, so the
 * method alone forces a preflight, which this app answers without CORS headers.
 */
export type LocalRequestKind = "read" | "json" | "bodiless";

/**
 * The app answers only a browser on this machine: a loopback `Host` (DNS rebinding sends a
 * foreign one), no cross-site fetch, and, when the browser names an `Origin`, this origin.
 */
export function assertLocalRequest(request: Request, kind: LocalRequestKind = "read"): void {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  let localOrigin: URL;
  try {
    localOrigin = new URL(`http://${host}`);
  } catch {
    throw new LocalRequestError(403, "This app only accepts local browser requests.");
  }
  if (!LOCAL_HOSTS.has(localOrigin.hostname)) {
    throw new LocalRequestError(403, "This app only accepts local browser requests.");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new LocalRequestError(403, "Cross-site requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== localOrigin.origin) {
    throw new LocalRequestError(403, "Cross-origin requests are not allowed.");
  }
  if (kind !== "json") return;
  const sent = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (sent !== "application/json") {
    throw new LocalRequestError(415, "This request must use JSON.");
  }
}
