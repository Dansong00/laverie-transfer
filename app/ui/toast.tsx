"use client";

import { useEffect, useState } from "react";

function TimedToast({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <div className="toast" role="status">{message}</div> : null;
}

export function Toast({ message }: { message: string }) {
  return message ? <TimedToast key={message} message={message} /> : null;
}
