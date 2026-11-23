import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { t, type Locale } from "../../i18n";
import { DirectoryError, readDirectory } from "../../staff/directory";
import { requestLocale } from "../../staff/request-profile";
import { sessionCookie } from "../../staff/session";
import { Directory } from "./directory";
import "../sign-in.css";
import "./staff.css";

export default async function StaffPage() {
  const locale = await requestLocale();
  return (
    <main className="sign-in staff-page">
      <Suspense fallback={<p>{t(locale, "loading")}</p>}>
        <AdminAccess locale={locale} />
      </Suspense>
    </main>
  );
}

async function AdminAccess({ locale }: { locale: Locale }) {
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
        ← {t(locale, "profile")}
      </Link>
      <h1>{t(locale, "directory")}</h1>
      <Directory {...directory} locale={locale} />
    </>
  );
}
