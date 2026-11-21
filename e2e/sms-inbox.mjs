// Loaded only into the Playwright web server. Intercept provider requests so no SMS leaves a test.
import { writeFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async function (input, options) {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== "https://api.telnyx.com/v2/messages") return original(input, options);
  const request = new Request(input, options);
  const sms = await request.json();
  if (sms.to !== "+12125550178" || request.headers.get("authorization") !== "Bearer playwright-only") {
    return new Response(null, { status: 403 });
  }
  const match = sms.text.match(/\n@staff\.example\.test #(\d{6})$/);
  if (!match) return new Response(null, { status: 400 });
  writeFileSync(process.env.LAVERIE_TEST_INBOX, match[1], { mode: 0o600 });
  return new Response(null, { status: 202 });
};
