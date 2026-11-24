import { AppHeader } from "./ui/app-header";
import { BackButton } from "./ui/back-button";
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
  if (!actor) return <>
    <div className="brand-bar" />
    <main className="e2e auth">
      <Image className="wordmark" src="/brand/laverie.webp" alt="Laverie" width={1500} height={428} priority />
      <SignIn />
    </main>
  </>;
  const locale = await requestLocale();
  return <>
    <AppHeader actor={actor} locale={locale} />
    <main className="e2e-body profile-page">
      <div className="back-row"><BackButton href="/board" label={t(locale, "batchStoreBoard", { store: "SoHo" })} /></div>
      <h1 className="flow-title">{t(locale, "profile")}</h1>
      <p className="flow-sub">{t(locale, "profileNote")}</p>
      <div className="card profile-card">
        <dl>
          <dt>{t(locale, "name")}</dt><dd>{actor.name}</dd>
          <dt>{t(locale, "role")}</dt><dd>{t(locale, actor.role === "admin" ? "admin" : "staff")}</dd>
          {actor.phone && <><dt>{t(locale, "phone")}</dt><dd>{actor.phone}</dd></>}
          <dt>{t(locale, "profileStore")}</dt><dd>{t(locale, "profileStoreValue")}</dd>
        </dl>
      </div>
      <form className="card profile-card" action={saveLanguage}>
        <label className="field-label" htmlFor="locale">{t(locale, "language")}</label>
        <select className="input" id="locale" name="locale" defaultValue={locale} key={locale}>
          <option value="en" lang="en">English</option>
          <option value="es" lang="es">Español</option>
        </select>
        <button className="btn btn-outline">{t(locale, "saveLanguage")}</button>
      </form>
      <form className="profile-signout" action={signOut}><button className="btn btn-outline btn-danger">{t(locale, "signOut")}</button></form>
    </main>
  </>;
}
