import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

// Reemplaza el token %SITE_URL% en index.html con la URL absoluta del sitio.
// Netlify inyecta `URL` (dominio de producción) en el build; en local queda
// vacío → las URLs relativas siguen funcionando para dev/preview.
const ROUTES = ['/', '/productos', '/beneficios', '/historia', '/tips', '/como-comprar', '/faq'];

function siteUrlHtml(): Plugin {
  const siteUrl = (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, '');
  return {
    name: 'html-site-url',
    transformIndexHtml(html) {
      return html.replace(/%SITE_URL%/g, siteUrl);
    },
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      const urls = ROUTES.map(
        (r) =>
          `  <url>\n    <loc>${siteUrl}${r}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n  </url>`
      ).join('\n');
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });

      const robots = `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`;
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), siteUrlHtml()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Separa las librerías de animación (gsap/motion/lenis) del bundle de la
      // app para mejorar el cacheo entre despliegues.
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            animation: ['gsap', 'motion', 'lenis', 'split-type'],
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
