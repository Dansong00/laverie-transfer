import { randomBytes, randomInt } from "node:crypto";

// Only imported by test runners. Mirror Verify's reuse of a pending challenge
// until it is canceled, approved, expired, or exhausted.
export function verifyFixture(phone, onSend) {
  if (process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview") {
    throw new Error("Test verification is restricted to local processes");
  }
  const base = "https://verify.twilio.com/v2/Services/test-service/";
  let pending;
  return async (input, options) => {
    const request = new Request(input, options);
    if (request.method !== "POST" || !request.url.startsWith(base) ||
        request.headers.get("authorization") !== "Basic " + Buffer.from("test-account:test-token").toString("base64")) {
      throw new Error("Unexpected test verification request");
    }
    const fields = new URLSearchParams(await request.text());
    const path = request.url.slice(base.length);
    const missing = () => new Response(null, { status: 404 });
    if (pending && pending.expires <= Date.now()) pending = undefined;
    if (pending && path === "Verifications/" + pending.sid && fields.get("Status") === "canceled") {
      pending = undefined;
      return Response.json({ status: "canceled" });
    }
    if (fields.get("To") !== phone) return missing();
    if (path === "Verifications" && fields.get("Channel") === "sms") {
      pending ??= {
        sid: "VE" + randomBytes(16).toString("hex"), code: randomInt(1000000).toString().padStart(6, "0"),
        attempts: 0, sends: [], expires: Date.now() + 600000,
      };
      pending.sends.push({ channel: "sms" });
      onSend(pending.code);
      return Response.json({ status: "pending", to: phone, sid: pending.sid, send_code_attempts: pending.sends }, { status: 201 });
    }
    if (pending && path === "VerificationCheck") {
      const { sid, code } = pending;
      const approved = fields.get("Code") === code;
      if (++pending.attempts >= 5 || approved) pending = undefined;
      return Response.json({ status: approved ? "approved" : "pending", sid, to: phone });
    }
    return missing();
  };
}
