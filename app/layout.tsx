import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Laverie Transfer",
  description: "Transfer board for SoHo and East Village.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
