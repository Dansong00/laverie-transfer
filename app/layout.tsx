import type { Metadata } from "next";

import { requestLocale } from "../staff/request-profile";

// The initial document language depends on the signed-in staff member.
export const instant = false;

export const metadata: Metadata = {
  title: "Laverie Transfer",
  description: "Transfer board for SoHo and East Village.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={await requestLocale()}>
      <body>{children}</body>
    </html>
  );
}
