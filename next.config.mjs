/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish Node module; keep it external to the server bundle.
  experimental: {
    serverComponentsExternalPackages: ["pg"],
  },
};

export default nextConfig;
