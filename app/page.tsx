import { AppHeader } from "./ui/app-header";
import Link from "next/link";
import Image from "next/image";
import { t } from "../i18n";
import { Suspense } from "react";
import { requestLocale, requestProfile } from "../staff/request-profile";
import { saveLanguage, signOut } from "./sign-in-actions";
import { SignIn } from "./sign-in";

export default function Home() {
  return <Suspense fallback={null}><StaffAccess /></Suspense>;
}

async function StaffAccess() {
  const actor = await requestProfile();
  if (!actor) return <main className="sign-in">
    <Image className="wordmark" src="/brand/laverie.webp" alt="Laverie" width={1500} height={428} priority />
    <SignIn />
  </main>;
  const locale = await requestLocale();
  return <>
    <AppHeader actor={actor} locale={locale} />
    <main className="sign-in profile-page">
      <h1>{t(locale, "profile")}</h1>
      <dl className="profile">
        <dt>{t(locale, "name")}</dt><dd>{actor.name}</dd>
        <dt>{t(locale, "role")}</dt><dd>{t(locale, actor.role === "admin" ? "admin" : "staff")}</dd>
        {actor.phone && <><dt>{t(locale, "phone")}</dt><dd>{actor.phone}</dd></>}
      </dl>
      <Link className="link" href="/orders">{t(locale, "orders")}</Link>
      {actor.role === "admin" && <Link className="link" href="/staff">{t(locale, "directory")}</Link>}
      <form action={saveLanguage}>
        <label htmlFor="locale">{t(locale, "language")}</label>
        <select id="locale" name="locale" defaultValue={locale} key={locale}>
          <option value="en" lang="en">English</option>
          <option value="es" lang="es">Español</option>
        </select>
        <button className="link">{t(locale, "saveLanguage")}</button>
      </form>
      <form action={signOut}><button className="primary">{t(locale, "signOut")}</button></form>
    </main>
  </>;
}
