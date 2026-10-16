import type { NextConfig } from "next";
import path from "node:path";

const runtimeStorage = process.env.ARCHIVE_STORAGE_DIR;
const storagePattern = runtimeStorage
  ? path.relative(process.cwd(), path.resolve(runtimeStorage)).split(path.sep).join('/').replace(/[!()*?\[\]{}]/g, '\\$&')
  : 'data';
const privateFiles = ['./.checkpoints/**/*', './data/**/*', './.env*', './.git/**/*', './SONGIE_CHATGPT_CONTEXT.md', `${storagePattern}/**/*`];

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  // Runtime storage is mounted on the server, never copied from build traces.
  // Use the supported Webpack build: Turbopack currently retains storage in proxy traces.
  outputFileTracingExcludes: {
    '/*': privateFiles,
    'middleware': privateFiles,
  },
};

export default nextConfig;
