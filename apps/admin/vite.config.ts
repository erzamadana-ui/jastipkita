/**
 * Vite config for the JastipKita admin SPA (static hosting).
 *  - base path from VITE_BASE_PATH (default "/"), API origin from VITE_API_BASE_URL (see .env.example)
 *  - production build injects a strict CSP <meta> (no inline script/style, connect-src = self + API origin only)
 *    and emits Cloudflare Pages `_headers` (same CSP + frame-ancestors/noindex headers, which a meta tag cannot carry)
 *  - no inlined data: assets (assetsInlineLimit 0) so the CSP needs no `data:` source
 */
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

function apiOrigin(raw: string | undefined): string {
  try {
    return new URL(raw ?? 'http://localhost:8787').origin;
  } catch {
    return 'http://localhost:8787';
  }
}

export function buildCsp(api: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src 'self' ${api}`,
    'frame-src blob:',
    "manifest-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function securityPlugin(api: string): Plugin {
  const csp = buildCsp(api);
  return {
    name: 'jk-admin-security',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
      },
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          `  Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
          '  X-Robots-Tag: noindex, nofollow, noarchive',
          '  X-Frame-Options: DENY',
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: no-referrer',
          '  Cross-Origin-Opener-Policy: same-origin',
          '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          '  Cache-Control: no-store',
          '/assets/*',
          '  ! Cache-Control',
          '  Cache-Control: public, max-age=31536000, immutable',
          '/fonts/*',
          '  ! Cache-Control',
          '  Cache-Control: public, max-age=604800',
          '',
        ].join('\n'),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = env.VITE_BASE_PATH && env.VITE_BASE_PATH.trim() ? env.VITE_BASE_PATH.trim() : '/';
  return {
    base: base.endsWith('/') ? base : `${base}/`,
    plugins: [react(), securityPlugin(apiOrigin(env.VITE_API_BASE_URL))],
    build: {
      target: 'es2022',
      sourcemap: false,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 900,
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
