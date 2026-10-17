import { LocalGatewayError } from "@/lib/gateway-error";
import { LocalRequestError } from "@/lib/local-request";

export const NO_STORE = { "cache-control": "private, no-store" } as const;

/** One owner-safe envelope for every same-origin route: `{ error: { message } }`, never a path or a token. */
export function routeFailure(error: unknown, fallback: string, fallbackStatus: number): Response {
  const known = error instanceof LocalGatewayError || error instanceof LocalRequestError;
  return Response.json(
    { error: { message: known ? error.message : fallback } },
    { status: known ? error.status : fallbackStatus, headers: NO_STORE },
  );
}
