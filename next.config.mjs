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

export default nextConfig;
