"use client";
import { useActionState, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import type { StoreId, stores } from "../../db/eligible-orders";
import { FilterIcon } from "../ui/filter-icon";
import { StoreBar } from "../ui/store-bar";
import { Toast } from "../ui/toast";
import { Banner } from "../ui/banner";
import { useRouter } from "next/navigation";
import { t, type Locale } from "../../i18n";
import type { Section } from "../../transfer/board";
import { saveSections } from "./actions";

export function BoardRefresh() {
  const router = useRouter();
  useEffect(() => {
    let queued: number | undefined;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(queued);
      queued = window.setTimeout(() => router.refresh(), 0);
    }
    const interval = window.setInterval(refresh, 45_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(queued);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}

// A draft follows the staff member around this tab. Saving makes it their server-side default.
const sectionChange = "laverie:board-sections";
const fallbackDrafts = new Map<string, string | null>();
function readDraft(key: string) {
  if (fallbackDrafts.has(key)) return fallbackDrafts.get(key) ?? null;
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function writeDraft(key: string, ids: string | null) {
  try {
    if (ids === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, ids);
    fallbackDrafts.delete(key);
  } catch {
    fallbackDrafts.set(key, ids);
  }
  window.dispatchEvent(new Event(sectionChange));
}
function subscribe(listener: () => void) {
  window.addEventListener(sectionChange, listener);
  return () => window.removeEventListener(sectionChange, listener);
}

type Props = {
  groups: { id: Section; name: string; content: ReactNode }[];
  visible: Section[];
  staffId: string;
  store: StoreId;
  names: typeof stores;
  locale: Locale;
  updatedAt: number;
};

type SaveResult = { status: Awaited<ReturnType<typeof saveSections>> | null; count: number };

export function SectionFilter({ groups, visible, staffId, store, names, locale, updatedAt }: Props) {
  const key = "laverie:board-sections:" + staffId;
  const draft = useSyncExternalStore(subscribe, () => readDraft(key), () => null);
  const selected = draft === null ? visible : draft.split(",");
  const hiddenCount = groups.filter(group => !selected.includes(group.id)).length;
  const panel = useRef<HTMLDetailsElement>(null);
  function close() {
    if (panel.current) {
      panel.current.open = false;
      panel.current.querySelector("summary")?.focus();
    }
  }
  const [result, action, pending] = useActionState<SaveResult, FormData>(async (previous, data) => {
    const status = await saveSections(null, data);
    if (status === "boardSectionsSaved") {
      writeDraft(key, null);
      close();
    }
    return { status, count: previous.count + 1 };
  }, { status: null, count: 0 });

  return <>
    <StoreBar store={store} names={names} locale={locale} updatedAt={updatedAt}>
      <details ref={panel} onKeyDown={event => { if (event.key === "Escape") close(); }}>
        <summary className="filter-btn">
          <span className="sr-only">{t(locale, "boardSections")}</span><FilterIcon />
          {hiddenCount > 0 && <span className="filter-badge" role="img"
            aria-label={t(locale, "boardHiddenBadge", { count: hiddenCount })}>{hiddenCount}</span>}
        </summary>
        <form className="view-panel view-panel-drop" action={action}>
          <p className="view-default-note">{t(locale, "boardFilterNote")}</p>
          <fieldset disabled={pending}>
            <legend className="sr-only">{t(locale, "boardShowSections")}</legend>
            {groups.map(({ id, name }) => <label key={id} className="view-option">
              <input type="checkbox" name="section" value={id} checked={selected.includes(id)}
                onChange={event => {
                  const next = groups.filter(group => group.id === id ? event.target.checked : selected.includes(group.id));
                  writeDraft(key, next.map(group => group.id).join(","));
                }} />{name}
            </label>)}
            <div className="view-panel-actions">
              <button className="btn">{t(locale, "boardSaveSections")}</button>
              <button type="button" className="btn btn-outline" onClick={close}>{t(locale, "done")}</button>
            </div>
          </fieldset>
          {result.status && result.status !== "boardSectionsSaved" && <Banner>{t(locale, result.status)}</Banner>}
        </form>
      </details>
    </StoreBar>
    <div className="e2e-body">
      <div className="cta-row"><Link className="btn" href={"/orders?store=" + store}>{t(locale, "boardCreateTransfer")}</Link></div>
      {hiddenCount === groups.length && <p>{t(locale, "boardHiddenSections")}</p>}
      {groups.map(({ id, name, content }) => <section key={id} className="board-group" aria-label={name} hidden={!selected.includes(id)}>
        <h2 className="group-label">{name}</h2><div className="card">{content}</div>
      </section>)}
    </div>
    {result.status === "boardSectionsSaved" && <Toast key={result.count} message={t(locale, result.status)} />}
  </>;
}
