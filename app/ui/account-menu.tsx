"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { t, type Locale } from "../../i18n";
import { signOut } from "../sign-in-actions";

export function AccountMenu({ locale, admin }: { locale: Locale; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("a")?.focus();
    function dismiss(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    }
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  return <>
    <button type="button" ref={toggle} className={`menu-btn${open ? " is-open" : ""}`}
      aria-expanded={open} aria-controls={id} aria-label={t(locale, open ? "menuClose" : "menuOpen")}
      onClick={() => setOpen(!open)}>
      <span className="hamburger" aria-hidden="true"><span /><span /><span /></span>
    </button>
    {open && <div className="menu-backdrop" onClick={() => { setOpen(false); toggle.current?.focus(); }} />}
    <nav id={id} ref={panel} className="account-menu" hidden={!open}
      onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== toggle.current) setOpen(false);
      }}>
      <Link href="/" onClick={() => setOpen(false)}>{t(locale, "profile")}</Link>
      {admin && <Link href="/staff" onClick={() => setOpen(false)}>{t(locale, "directory")}</Link>}
      <form action={signOut}><button className="is-danger">{t(locale, "signOut")}</button></form>
    </nav>
  </>;
}
