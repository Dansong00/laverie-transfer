import type { NextRequest } from "next/server";
import { readSession, sessionCookie } from "../../../staff/session";

export async function GET(request: NextRequest) {
  const actor = await readSession(request.cookies.get(sessionCookie)?.value);
  return Response.json(actor ?? { error: "Sign in required." }, {
    status: actor ? 200 : 401, headers: { "Cache-Control": "private, no-store" },
  });
}
