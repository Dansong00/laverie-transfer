import { isIP } from "node:net";

// Vercel supplies a single public client address. Local Next.js runs have no
// trusted edge, so client-supplied forwarding headers are ignored there.
export function signInClientIp(headers: Pick<Headers, "get">) {
  if (process.env.VERCEL !== "1") return "127.0.0.1";
  const ip = headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  switch (isIP(ip)) {
    case 4: return ip;
    case 6: return new URL(`http://[${ip}]`).hostname.slice(1, -1);
    default: throw new Error("Missing Vercel client address");
  }
}
