export async function sendCode(phone: string, code: string) {
  const domain = process.env.APP_DOMAIN;
  const key = process.env.SMS_PROVIDER_API_KEY;
  const from = process.env.SMS_FROM;
  if (!domain || !/^[a-z0-9.-]+$/i.test(domain) || !key || !from) {
    throw new Error("Sign-in SMS configuration is incomplete");
  }
  const text = `Your Laverie sign-in code is ${code}.\n\n@${domain} #${code}`;
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: phone, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("SMS provider rejected delivery");
}
