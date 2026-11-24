import { ingestCentsEvent, InvalidCentsEvent, UnauthorizedCentsEvent } from "../../../../cents/ingest";

import { configuredDemoDatabase } from "../../../../staff/preview-demo";

export async function POST(request: Request) {
  if (configuredDemoDatabase()) return new Response(null, { status: 503 });
  const receivedAt = new Date();
  try {
    const name = process.env.CENTS_WEBHOOK_HEADER_NAME;
    if (!name) throw new Error("Missing Cents header name");
    await ingestCentsEvent(await request.text(), request.headers.get(name), receivedAt);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof UnauthorizedCentsEvent) return new Response(null, { status: 401 });
    if (error instanceof InvalidCentsEvent) return new Response(null, { status: 400 });
    return new Response(null, { status: 503 });
  }
}
