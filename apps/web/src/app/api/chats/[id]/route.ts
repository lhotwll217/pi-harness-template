import { chatToBootstrap, emptyBootstrap } from "@/lib/chat-history";
import { deleteChat, getChat, LocalGatewayError, renameChat } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import { NO_STORE, routeFailure } from "../../route-failure";

export const runtime = "nodejs";

interface ChatRoute { readonly params: Promise<{ id: string }> }

/** A chat the client minted but never sent to is not on disk yet; it opens empty. */
export async function GET(request: Request, { params }: ChatRoute): Promise<Response> {
  try {
    assertLocalRequest(request);
    const { id } = await params;
    try {
      return Response.json(chatToBootstrap(await getChat(id)), { headers: NO_STORE });
    } catch (error: unknown) {
      if (error instanceof LocalGatewayError && error.status === 404) return Response.json(emptyBootstrap(id), { headers: NO_STORE });
      throw error;
    }
  } catch (error: unknown) {
    return routeFailure(error, "The app could not load that chat.", 503);
  }
}

export async function PATCH(request: Request, { params }: ChatRoute): Promise<Response> {
  try {
    assertLocalRequest(request, "json");
    const { id } = await params;
    const { title } = await request.json() as { title?: unknown };
    if (typeof title !== "string" || !title.trim()) throw new TypeError("title must be text");
    return Response.json(await renameChat(id, title.trim()), { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "The rename request is invalid.", 400);
  }
}

export async function DELETE(request: Request, { params }: ChatRoute): Promise<Response> {
  try {
    assertLocalRequest(request, "bodiless");
    const { id } = await params;
    await deleteChat(id);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "The delete request is invalid.", 400);
  }
}
