import type { NextRequest } from "next/server";
import { sessionCookie } from "../../../staff/session";
import { BatchError } from "../../../transfer/commands";
import { saveBatch } from "../../../transfer/planned";

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new BatchError(403, "Same-origin request required.");
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
      throw new BatchError(415, "Send a JSON batch change.");
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      throw new BatchError(400, "Invalid JSON.");
    }
    const outcome = await saveBatch(
      request.cookies.get(sessionCookie)?.value,
      input,
      request.nextUrl.searchParams.get("check") === "1",
    );
    if (!outcome) return Response.json({ pending: true }, { status: 202, headers });
    return Response.json(outcome, { status: outcome.ok ? 200 : outcome.status, headers });
  } catch (error) {
    if (error instanceof BatchError)
      return Response.json({ error: error.message }, { status: error.status, headers });
    console.error("Batch planning transaction failed");
    return Response.json({ error: "Batch planning is unavailable." }, { status: 503, headers });
  }
}
