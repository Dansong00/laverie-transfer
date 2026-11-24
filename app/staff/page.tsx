import { AppHeader } from "../ui/app-header";
import { BackButton } from "../ui/back-button";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { t, type Locale } from "../../i18n";
import { DirectoryError, readDirectory } from "../../staff/directory";
import { requestLocale, requestProfile } from "../../staff/request-profile";
import { sessionCookie } from "../../staff/session";
import { Directory } from "./directory";

export default async function StaffPage() {
  const locale = await requestLocale();
  return (
    <Suspense fallback={<p className="e2e-body flow-sub">{t(locale, "loading")}</p>}>
      <AdminAccess locale={locale} />
    </Suspense>
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
  const actor = await requestProfile();
  if (!actor) redirect("/");
  return (
    <>
      <AppHeader actor={actor} locale={locale} />
      <main className="e2e-body staff-page">
        <div className="back-row"><BackButton href="/" label={t(locale, "profile")} /></div>
        <h1 className="flow-title">{t(locale, "directory")}</h1>
        <p className="flow-sub">{t(locale, "staffIntro")}</p>
        <Directory {...directory} locale={locale} />
      </main>
    </>
  );
}
