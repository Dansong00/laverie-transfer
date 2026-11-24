import type { ReactNode } from "react";

export function Banner({ children }: { children: ReactNode }) {
  return <div className="banner banner-warn" role="alert">{children}</div>;
}
