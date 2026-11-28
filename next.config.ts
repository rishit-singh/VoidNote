import path from "node:path";
import { fileURLToPath } from "node:url";

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

// CI builds need binding shape/context, not access to live provider resources.
void initOpenNextCloudflareForDev({ remoteBindings: !process.env.CI });

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
