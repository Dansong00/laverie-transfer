import type { NextRequest } from "next/server";
import { sessionCookie } from "../../../staff/session";
import { BatchError } from "../../../transfer/commands";
import { saveBatch } from "../../../transfer/planned";

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new BatchError(403, "BATCH_SAME_ORIGIN_REQUIRED");
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      throw new BatchError(415, "BATCH_JSON_REQUIRED");
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      throw new BatchError(400, "BATCH_INVALID_JSON");
    }
    const outcome = await saveBatch(
      request.cookies.get(sessionCookie)?.value,
      input,
      request.nextUrl.searchParams.get("check") === "1",
    );
    if (!outcome) return Response.json({ pending: true }, { status: 202, headers });
    return Response.json(outcome, { status: outcome.ok ? 200 : outcome.status, headers });
  } catch (error) {
    const failure = error instanceof BatchError ? error : new BatchError(503, "BATCH_UNAVAILABLE");
    if (failure !== error) console.error("Batch planning transaction failed");
    return Response.json(failure.payload(), { status: failure.status, headers });
  }
}
