/** @type {import('next').NextConfig} */
const nextConfig = {
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
