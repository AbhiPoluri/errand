/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained production server (.next/standalone/server.js + a minimal node_modules) so the
  // Electron main process can host it without the full repo — a fixed-loopback Next server is the
  // first wrap's UI+API host (the renderer loads it over http, the Chrome extension keeps talking to
  // it over http). For packaging, the externalized native-ish deps below are asarUnpacked.
  output: "standalone",
  // playwright-core and unpdf (bundled pdfjs) have dynamic requires / heavy internals —
  // keep them out of the webpack bundle and require them at runtime in the Node-runtime
  // route handlers. (Next 14 key.)
  experimental: {
    serverComponentsExternalPackages: ["playwright-core", "unpdf", "tesseract.js"],
  },
  // The harness in src/ imports siblings with explicit .ts extensions (so it also runs
  // standalone under tsx). Teach webpack to resolve those specifiers.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".ts": [".ts", ".tsx"],
      ".tsx": [".tsx"],
    };
    return config;
  },
};

export default nextConfig;
