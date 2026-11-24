import type { Metadata, Viewport } from "next";

import { requestLocale } from "../staff/request-profile";

import "./styles/tokens.css";
import "./styles/c2.css";
import "./styles/components.css";
import "./styles/e2e.css";
import "./styles/app.css";

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#FAFAF9" };

// The initial document language depends on the signed-in staff member.
export const instant = false;

export const metadata: Metadata = {
  title: "Laverie Transfer",
  description: "Transfer board for SoHo and East Village.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={await requestLocale()}>
      <body className="page e2e-page"><div className="app-shell">{children}</div></body>
    </html>
  );
}
