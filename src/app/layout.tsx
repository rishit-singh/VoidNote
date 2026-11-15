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

const monoItalic = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: "400",
  style: "italic",
  display: "swap",
  variable: "--font-ibm-plex-mono-italic",
});

export const metadata: Metadata = {
  title: "VoidNote",
  description:
    "Transcribe recordings, connect speakers to profiles, and revisit their words across conversations. Explore VoidNote’s plans for source-linked context and conversation preparation.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${mono.variable} ${monoItalic.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider defaultTheme="dark" storageKey="voidnote-theme">
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
