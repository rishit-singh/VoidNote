import localFont from "next/font/local";

export const mono = localFont({
  src: [
    { path: "./IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "./IBMPlexMono-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./IBMPlexMono-Bold.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-ibm-plex-mono",
});

export const monoItalic = localFont({
  src: "./IBMPlexMono-Italic.woff2",
  weight: "400",
  style: "italic",
  display: "swap",
  variable: "--font-ibm-plex-mono-italic",
});
