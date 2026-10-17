import { listChats } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import { NO_STORE, routeFailure } from "../route-failure";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    return Response.json(await listChats(), { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "The app could not list the chats.", 503);
  }
}
