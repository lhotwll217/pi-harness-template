import { createUIMessageStreamResponse } from "ai";
import { chatEventsToUIMessageStream } from "@/lib/chat-ai-stream";
import { parseChatApiRequest } from "@/lib/chat-request";
import { LocalGatewayError, streamChatTurn } from "@/lib/gateway-client.server";
import { assertLocalRequest, LocalRequestError } from "@/lib/local-request";
import { NO_STORE } from "../../../route-failure";

export const runtime = "nodejs";

/** `useChat` reads a refusal's body as plain text, so this route answers refusals that way. */
export async function POST(request: Request, { params }: { readonly params: Promise<{ id: string }> }): Promise<Response> {
  try {
    assertLocalRequest(request, "json");
    const { id } = await params;
    const { text } = parseChatApiRequest(await request.json());
    return createUIMessageStreamResponse({
      stream: chatEventsToUIMessageStream(await streamChatTurn(id, text, request.signal)),
      headers: NO_STORE,
    });
  } catch (error: unknown) {
    const known = error instanceof LocalGatewayError || error instanceof LocalRequestError;
    return new Response(known ? error.message : "The chat request is invalid.", {
      status: known ? error.status : 400,
      headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
    });
  }
}
