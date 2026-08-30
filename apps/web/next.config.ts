import type { NextConfig } from "next";

const config: NextConfig = {
  // Die internen Pakete werden als TypeScript-Quellen eingebunden (Internal-
  // Packages-Muster) — Next transpiliert sie mit.
  transpilePackages: ["@sae/core", "@sae/config", "@sae/db", "@sae/observability"],
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
