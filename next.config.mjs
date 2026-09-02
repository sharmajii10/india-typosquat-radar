/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
  // The job routes talk to DNS, RDAP and candidate hosts, so they need the
  // Node.js runtime. That is the default in Next 16 and the Edge runtime is
  // deprecated, so no per-route `runtime` export is needed - see
  // node_modules/next/dist/docs for the current guidance.
};

export default nextConfig;
