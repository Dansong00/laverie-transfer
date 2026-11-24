"use client";

import { useEffect, useState } from "react";
import { t, type Locale } from "../../i18n";

export function UpdatedAgo({ locale, updatedAt }: { locale: Locale; updatedAt: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [updatedAt]);
  return <span className="updated">
    {seconds < 5 ? t(locale, "boardUpdatedNow") : t(locale, "boardUpdatedAgo", { seconds })}
  </span>;
}
