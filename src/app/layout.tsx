import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StockOff - the stock market, turned into a game",
  description:
    "Free stock trading game. Start with $100,000 in simulated money, build a portfolio and compete against your friends and a live AI trader. No real risk, real investing lessons.",
};

export const viewport: Viewport = {
  themeColor: "#060b1c",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
