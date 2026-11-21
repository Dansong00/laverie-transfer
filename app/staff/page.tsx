import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { DirectoryError, readDirectory } from "../../staff/directory";
import { sessionCookie } from "../../staff/session";
import { Directory } from "./directory";
import "../sign-in.css";
import "./staff.css";

export default function StaffPage() {
  return (
    <main className="sign-in staff-page">
      <Suspense fallback={<p>Loading…</p>}>
        <AdminAccess />
      </Suspense>
    </main>
  );
}

async function AdminAccess() {
  const token = (await cookies()).get(sessionCookie)?.value;
  if (!token) redirect("/");
  let directory;
  try {
    directory = await readDirectory(token);
  } catch (error) {
    if (error instanceof DirectoryError && (error.status === 401 || error.status === 403)) redirect("/");
    throw error;
  }
  return (
    <>
      <Link href="/" className="back">
        ← Profile
      </Link>
      <h1>Staff admin</h1>
      <Directory {...directory} />
    </>
  );
}
