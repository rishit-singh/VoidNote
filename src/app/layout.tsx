import type { Metadata } from "next";
import { IBM_Plex_Mono } from "next/font/google";

import "@/app/globals.css";
import "@/App.css";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryProvider } from "@/components/query-provider";

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-ibm-plex-mono",
});

export const metadata: Metadata = {
  title: "VoidNote",
  description:
    "Stay in the conversation. Record it, turn it into a speaker-labelled transcript, and come back to every word with VoidNote.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${mono.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider defaultTheme="dark" storageKey="voidnote-theme">
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
