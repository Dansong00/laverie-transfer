// Playwright preloads this file only in its local web server.
import { writeFileSync } from "node:fs";
import { verifyFixture } from "./verify-fixture.mjs";
const original = globalThis.fetch;
const verify = verifyFixture("+12125550178", code =>
  writeFileSync(process.env.LAVERIE_TEST_INBOX, code, { mode: 0o600 }));
globalThis.fetch = (input, options) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith("https://verify.twilio.com/") ? verify(input, options) : original(input, options);
};
