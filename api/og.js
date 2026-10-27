/**
 * Image d'aperçu (Open Graph) d'une fiche : /api/og?s=<slug>
 *
 * Rendue par @vercel/og (Satori + Resvg). Les robots des réseaux sociaux ne
 * lisent pas le JavaScript : c'est api/place.js qui place cette adresse dans le
 * <head> de la page, côté serveur.
 *
 * Deux précautions apprises à l'usage :
 *   - la forme d'export est l'objet `{ fetch(request) }` (standard Web), comme
 *     api/place.js ;
 *   - le corps de l'image est lu ici (await arrayBuffer) au lieu d'être
 *     transmis en flux : le rendu est asynchrone, et sans cette lecture une
 *     erreur ne remonterait pas — on servirait un en-tête image/png vide.
 */
import { SITE_ORIGIN, fetchPlace, idFromSlug } from '../lib/place.js';
import { cardElement } from '../lib/card.js';

const CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

// Diagnostic temporaire, à retirer une fois l'image validée en ligne.
const DIAG = 'hil-og-diag';

export default {
  async fetch(request) {
    const diag = String(request.url || '').includes('diag=' + DIAG);
    try {
      const { ImageResponse } = await import('@vercel/og');
      const url = new URL(request.url, SITE_ORIGIN);
      const slug = url.searchParams.get('s') || '';

      const place = await fetchPlace(idFromSlug(slug));
      if (!place) throw new Error('fiche introuvable');

      const image = new ImageResponse(cardElement(place), { width: 1200, height: 630 });
      const png = Buffer.from(await image.arrayBuffer());
      if (!png.length) throw new Error('rendu vide');

      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': CACHE },
      });
    } catch (err) {
      if (diag) {
        return new Response('Diagnostic /api/og\n\n' + (err && err.stack ? err.stack : String(err)), {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      // Jamais d'image cassée : on retombe sur l'aperçu générique du site.
      return new Response(null, {
        status: 302,
        headers: { location: '/og-image.png', 'cache-control': 'public, max-age=300' },
      });
    }
  },
};
