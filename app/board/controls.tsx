"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
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

export function SectionFilter({
  choices,
  visible,
}: {
  choices: { id: Section; name: string }[];
  visible: Section[];
}) {
  const [status, action, pending] = useActionState(saveSections, "");
  return (
    <details>
      <summary>Board sections</summary>
      <form action={action}>
        <fieldset disabled={pending}>
          <legend>Show sections</legend>
          {choices.map((s) => (
            <label key={s.id}>
              <input type="checkbox" name="section" value={s.id} defaultChecked={visible.includes(s.id)} />{" "}
              {s.name}
            </label>
          ))}
          <button>Save sections</button>
        </fieldset>
        <p role="status">{status}</p>
      </form>
    </details>
  );
}
