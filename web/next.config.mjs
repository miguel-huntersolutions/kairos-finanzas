import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aquí = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // web/ tiene su propio package-lock: la raíz del rastreo es esta carpeta.
  outputFileTracingRoot: aquí,
  // Los handlers de ../src/lib importan pg, svix y zod: se resuelven desde web/node_modules
  // (en Vercel, la raíz del proyecto es web/ y no existe node_modules en la raíz del repo).
  serverExternalPackages: ['pg', 'svix'],
  webpack(config) {
    config.resolve.modules = [join(aquí, 'node_modules'), ...(config.resolve.modules ?? ['node_modules'])];
    return config;
  },
};
