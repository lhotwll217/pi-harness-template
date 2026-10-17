import { cancelChatTurn } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import { NO_STORE, routeFailure } from "../../../route-failure";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { readonly params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertLocalRequest(request, "json");
    const { id } = await params;
    const { turnId } = await request.json() as { turnId?: unknown };
    if (turnId !== undefined && typeof turnId !== "string") throw new TypeError("turnId must be text");
    return Response.json(await cancelChatTurn(id, turnId), { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "The cancel request is invalid.", 400);
  }
}
