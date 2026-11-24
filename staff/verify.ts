// Verify owns the SMS and code. Only its non-secret challenge reference is persisted.
const verificationSid = /^VE[0-9a-f]{32}$/i;

async function post(path: string, fields: Record<string, string>) {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!account || !token || !service) throw new Error("Sign-in provider configuration is incomplete");
  return fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(service)}/${path}`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(account + ":" + token).toString("base64") },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    cache: "no-store",
  });
}

async function start(to: string) {
  const response = await post("Verifications", { To: to, Channel: "sms" });
  if (!response.ok) throw new Error("Verification start failed");
  const data = await response.json();
  if (data.status !== "pending" || typeof data.sid !== "string" || !verificationSid.test(data.sid) || data.to !== to) {
    throw new Error("Unexpected verification start response");
  }
  const sid: string = data.sid;
  return { sid, reused: Array.isArray(data.send_code_attempts) && data.send_code_attempts.length > 1 };
}

// Verify can resend the same code while a challenge is pending. Cancel it
// before starting a replacement, including after a staff disable/re-enable.
export async function cancelVerification(sid: string) {
  if (!verificationSid.test(sid)) throw new Error("Invalid verification reference");
  const response = await post("Verifications/" + sid, { Status: "canceled" });
  if (response.status !== 404 && !response.ok) throw new Error("Verification cancellation failed");
}

export async function startVerification(to: string) {
  const started = await start(to);
  if (!started.reused) return started.sid;
  // A previous start can reach Verify even if its response never reaches us.
  // Do not attach that already-delivered code to a fresh local challenge.
  await cancelVerification(started.sid);
  const fresh = await start(to);
  if (fresh.reused || fresh.sid === started.sid) throw new Error("Expected a new verification");
  return fresh.sid;
}

export async function checkVerification(to: string, code: string, expectedSid: string) {
  const response = await post("VerificationCheck", { To: to, Code: code });
  if (response.status === 404) return false;
  if (response.status === 429) {
    const error = await response.json();
    if (error.code === 60202) return false; // Verify's maximum check attempts reached.
  }
  if (response.status !== 200) throw new Error("Verification check unavailable");
  const data = await response.json();
  return data.status === "approved" && data.sid === expectedSid && data.to === to;
}
