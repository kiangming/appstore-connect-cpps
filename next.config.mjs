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
};

export default nextConfig;
