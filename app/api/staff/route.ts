import type { NextRequest } from "next/server";
import { DirectoryError, listStaff, saveStaffChange } from "../../../staff/directory";
import { sessionCookie } from "../../../staff/session";

async function respond(run: () => Promise<unknown>) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    return Response.json(await run(), { headers });
  } catch (error) {
    const failure = error instanceof DirectoryError ? error : new DirectoryError(503, "DIRECTORY_UNAVAILABLE");
    if (failure !== error) console.error("Staff directory request failed");
    return Response.json({ error: failure.code, message: failure.message }, { status: failure.status, headers });
  }
}

export function GET(request: NextRequest) {
  return respond(() => listStaff(request.cookies.get(sessionCookie)?.value));
}

export function POST(request: NextRequest) {
  return respond(async () => {
    // Only accept JSON. A cross-origin browser form cannot submit this content type.
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new DirectoryError(403, "DIRECTORY_SAME_ORIGIN_REQUIRED");
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      throw new DirectoryError(415, "DIRECTORY_JSON_REQUIRED");
    }
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      throw new DirectoryError(400, "DIRECTORY_INVALID_JSON");
    }
    return saveStaffChange(request.cookies.get(sessionCookie)?.value, input);
  });
}
