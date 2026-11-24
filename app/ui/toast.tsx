"use client";

import { useEffect, useState } from "react";

type Props = { message: string; detail?: string };

function TimedToast({ message, detail }: Props) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <p className="toast" role="status" aria-live="polite"><span>{message}</span>{detail && <> <span>{detail}</span></>}</p> : null;
}

export function Toast({ message, detail }: Props) {
  return message ? <TimedToast key={message} message={message} detail={detail} /> : null;
}
