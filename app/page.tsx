import Link from "next/link";
import Image from "next/image";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { getProfile, sessionCookie } from "../staff/session";
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
  const actor = await getProfile((await cookies()).get(sessionCookie)?.value);
  if (!actor) return <SignIn />;
  return <>
    <h1>Profile</h1>
    <dl className="profile">
      <dt>Name</dt><dd>{actor.name}</dd>
      <dt>Role</dt><dd>{actor.role === "admin" ? "Admin" : "Staff"}</dd>
      {actor.phone && <><dt>Registered number</dt><dd>{actor.phone}</dd></>}
    </dl>
    <Link className="link" href="/board">Transfer board</Link>
    <Link className="link" href="/orders">Eligible orders</Link>
    {actor.role === "admin" && <Link className="link" href="/staff">Staff admin</Link>}
    <form action={signOut}><button className="primary">Sign out</button></form>
  </>;
}
