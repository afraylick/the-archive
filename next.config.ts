import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  outputFileTracingExcludes: {
    '/api/files/*/waveform': ['./next.config.ts'],
  },
};

export default nextConfig;
