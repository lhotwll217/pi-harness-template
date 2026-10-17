import { getWorkspaceFile, LocalGatewayError, putWorkspaceFile } from "@/lib/gateway-client.server";
import { assertLocalRequest } from "@/lib/local-request";
import { NO_STORE, routeFailure } from "../../route-failure";

export const runtime = "nodejs";

function requestedPath(request: Request): string {
  const path = new URL(request.url).searchParams.get("path");
  if (!path) throw new TypeError("ask for a path");
  return path;
}

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    return Response.json(await getWorkspaceFile(requestedPath(request)), { headers: NO_STORE });
  } catch (error: unknown) {
    return routeFailure(error, "That file request is invalid.", 400);
  }
}

/**
 * A stale `baseRevision` answers 409 with the file as it is on disk now, so the editor can
 * show both versions without a second request.
 */
export async function PUT(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request, "json");
    const path = requestedPath(request);
    const { content, baseRevision } = await request.json() as { content?: unknown; baseRevision?: unknown };
    if (typeof content !== "string") throw new TypeError("content must be text");
    if (baseRevision !== undefined && typeof baseRevision !== "string") throw new TypeError("baseRevision must be text");
    try {
      return Response.json(await putWorkspaceFile(path, content, baseRevision), { headers: NO_STORE });
    } catch (error: unknown) {
      if (!(error instanceof LocalGatewayError) || error.code !== "file_changed") throw error;
      return Response.json(
        { error: { message: "This file changed on disk." }, current: await getWorkspaceFile(path) },
        { status: 409, headers: NO_STORE },
      );
    }
  } catch (error: unknown) {
    return routeFailure(error, "That save is invalid.", 400);
  }
}
