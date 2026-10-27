/**
 * Image d'aperçu (Open Graph) d'une fiche : /api/og?s=<slug>
 *
 * Les robots des réseaux sociaux ne lisent pas le JavaScript : c'est
 * api/place.js qui place cette adresse dans le <head> de la page, côté serveur.
 *
 * Rendu par Satori (mise en page SVG) puis Resvg (SVG → PNG), sur le runtime
 * Node. @vercel/og a été écarté : son paquet ne se charge pas dans une fonction
 * Node de ce projet (« Dynamic require of "fs" is not supported » dans son
 * propre bundle), Satori et Resvg en sont les moteurs, et ils s'exécutent ici
 * comme en local — donc l'aperçu peut être vérifié avant publication.
 *
 * Deux formes à respecter :
 *   - l'export `{ fetch(request) }` (standard Web), comme api/place.js ;
 *   - la lecture du corps (await arrayBuffer) avant de répondre : le rendu est
 *     asynchrone, et sans cette lecture une erreur ne remonterait pas — on
 *     servirait un en-tête image/png vide.
 */
import { SITE_ORIGIN, fetchPlace, idFromSlug } from '../lib/place.js';
import { cardElement } from '../lib/card.js';
import { cardFonts } from '../lib/font.js';

const CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

// Diagnostic temporaire, à retirer une fois l'image validée en ligne.
const DIAG = 'hil-og-diag';

export default {
  async fetch(request) {
    const diag = String(request.url || '').includes('diag=' + DIAG);
    try {
      const [{ default: satori }, { Resvg }, fonts] = await Promise.all([
        import('satori'),
        import('@resvg/resvg-js'),
        cardFonts(),
      ]);

      const url = new URL(request.url, SITE_ORIGIN);
      const place = await fetchPlace(idFromSlug(url.searchParams.get('s') || ''));
      if (!place) throw new Error('fiche introuvable');

      const svg = await satori(cardElement(place), { width: 1200, height: 630, fonts });
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
      if (!png || !png.length) throw new Error('rendu vide');

      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length), 'cache-control': CACHE },
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
