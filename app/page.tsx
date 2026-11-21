import Image from "next/image";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { readSession, sessionCookie } from "../staff/session";
import { signOut } from "./sign-in-actions";
import { SignIn } from "./sign-in";
import "./sign-in.css";

export default function Home() {
  return (
    <main className="sign-in">
      <Image className="wordmark" src="/brand/laverie.webp" alt="Laverie" width={1500} height={428} priority />
      <Suspense fallback={<p>Loading sign-in…</p>}><StaffAccess /></Suspense>
    </main>
  );
}

async function StaffAccess() {
  const actor = await readSession((await cookies()).get(sessionCookie)?.value);
  if (!actor) return <SignIn />;
  return <>
    <h1>Signed in</h1>
    <p>{actor.name}</p>
    <form action={signOut}><button className="primary">Sign out</button></form>
  </>;
}
