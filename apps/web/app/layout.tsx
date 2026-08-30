import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Solana Alpha Engine",
  description: "Autonomes Solana-Trading-System",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
