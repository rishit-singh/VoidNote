import type { Metadata } from "next";

import "@/app/globals.css";
import { assetUrls } from "@/assets";
import { mono, monoItalic } from "@/assets/fonts";
import { ThemeProvider } from "@/components/theme-provider";
import { QueryProvider } from "@/components/query-provider";

export const metadata: Metadata = {
  title: "VoidNote",
  icons: {
    icon: [
      { url: assetUrls.favicon, type: "image/svg+xml", sizes: "any" },
      { url: assetUrls.faviconIco, type: "image/x-icon", sizes: "16x16 32x32 48x48" },
    ],
    apple: { url: assetUrls.appleTouchIcon, sizes: "180x180", type: "image/png" },
  },
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
