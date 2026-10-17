import { harnessPaths } from "@pi-template/contracts/harness-home";
import { daemonState } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import type { AppStatus } from "@/lib/chat-types";
import { NO_STORE, routeFailure } from "../route-failure";

export const runtime = "nodejs";

/** Always 200 for a local caller: the daemon's state, which `npm start` waits on, and the home it serves, which `npm start` matches before reusing this app. */
export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    const status: AppStatus = { daemon: await daemonState(), home: harnessPaths().home };
    return Response.json(status, { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "The app is unavailable.", 503);
  }
}
