/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lean production image: `next build` emits a self-contained server
  // under .next/standalone that the Dockerfile copies into the runtime.
  output: "standalone",
};

export default nextConfig;
