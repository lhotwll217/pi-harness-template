import { LocalGatewayError, streamGatewayEvents } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import { NO_STORE, routeFailure } from "../route-failure";

export const runtime = "nodejs";

const EVENT_STREAM = { "content-type": "text/event-stream", ...NO_STORE } as const;

/**
 * The frame an unreachable daemon gets. An `EventSource` that receives an error status stops
 * for good, so the page would never learn the daemon came back; a stream that says "down" and
 * closes keeps the browser reconnecting on its own.
 */
export const DAEMON_DOWN_FRAME = 'retry: 2000\nevent: daemon\ndata: {"state":"down"}\n\n';

/** A raw pipe of the daemon's invalidation stream; the browser owns reconnection. */
export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
  } catch (error: unknown) {
    return routeFailure(error, "The app is unavailable.", 403);
  }
  try {
    const upstream = await streamGatewayEvents(request.signal);
    return new Response(upstream.body, { headers: { ...EVENT_STREAM, connection: "keep-alive" } });
  } catch (error: unknown) {
    if (error instanceof LocalGatewayError && error.status !== 503) return routeFailure(error, "The app is unavailable.", 503);
    return new Response(DAEMON_DOWN_FRAME, { headers: EVENT_STREAM });
  }
}
