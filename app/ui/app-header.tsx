import Image from "next/image";
import Link from "next/link";
import { t, type Locale } from "../../i18n";
import { AccountMenu } from "./account-menu";

type Props = {
  locale: Locale;
  actor: { name: string; role: string };
  store?: "soho" | "east_village";
};

export function AppHeader({ locale, actor, store }: Props) {
  const admin = actor.role === "admin";
  return (
    <div className={`chrome-sticky ${store === "east_village" ? "store-ev" : "store-soho"}`}>
      <div className="brand-bar" />
      <header className="e2e-header">
        <Link href={store ? `/board?store=${store}` : "/board"} aria-label={t(locale, "board")}>
          <Image className="wordmark" src="/brand/laverie.webp" alt="Laverie" width={1500} height={428} />
        </Link>
        <div className="who-menu">
          <div className="who"><strong>{actor.name.trim().split(/\s+/)[0]} · {t(locale, admin ? "admin" : "staff")}</strong></div>
          <AccountMenu locale={locale} admin={admin} />
        </div>
      </header>
    </div>
  );
}
