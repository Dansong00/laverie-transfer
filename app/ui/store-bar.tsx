import Link from "next/link";
import type { ReactNode } from "react";
import type { StoreId, stores } from "../../db/eligible-orders";
import { t, type Locale } from "../../i18n";
import { UpdatedAgo } from "./updated-ago";

type Props = { store: StoreId; names: typeof stores; locale: Locale; updatedAt: number; children: ReactNode };

export function StoreBar({ store, names, locale, updatedAt, children }: Props) {
  return <div className="store-bar">
    <div className="store-band" />
    <div className="store-bar-inner">
      <div className="store-bar-row store-bar-title">
        <h2 className="store-name">{names[store]}</h2>
        <UpdatedAgo key={updatedAt} updatedAt={updatedAt} locale={locale} />
      </div>
      <div className="store-bar-row store-bar-controls">
        <nav className="switch store-switch" aria-label={t(locale, "store")}>
          {Object.entries(names).map(([id, name]) => <Link key={id} href={"/board?store=" + id}
            aria-current={id === store ? "page" : undefined}>{name}</Link>)}
        </nav>
        {children}
      </div>
    </div>
  </div>;
}
