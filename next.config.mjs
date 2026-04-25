import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.mzstatic.com",
      },
    ],
  },
  experimental: {
    // Ship re2-wasm as an external Node dependency rather than bundling it.
    // The package's .wasm binary is not copied into the build output path
    // that webpack expects, so bundled builds fail at page-data collection
    // with ENOENT on re2.wasm. Marking it external makes the runtime load
    // from node_modules/re2-wasm/ via plain Node require().
    serverComponentsExternalPackages: ["re2-wasm"],
  },
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Source map upload only when auth token is present (CI/Railway build),
  // so local builds without credentials stay quiet and fast.
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
  },
  // Strip source maps from the client bundle after upload to Sentry.
  hideSourceMaps: true,
});
