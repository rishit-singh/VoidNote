import path from "node:path";
import { fileURLToPath } from "node:url";

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

void initOpenNextCloudflareForDev();

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: repoRoot,
  redirects() {
    return Promise.resolve([
      { source: "/favicon.ico", destination: "/assets/brand/favicon.ico", permanent: true },
      { source: "/logo.svg", destination: "/assets/brand/legacy-logo.svg", permanent: true },
    ]);
  },
};

export default nextConfig;
