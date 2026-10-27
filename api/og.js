/**
 * Image d'aperçu (Open Graph) d'une fiche : /api/og?s=<slug>
 *
 * Les robots des réseaux sociaux ne lisent pas le JavaScript : c'est
 * api/place.js qui place cette adresse dans le <head> de la page, côté serveur.
 *
 * Rendu par Satori (mise en page SVG) puis Resvg (SVG → PNG), sur le runtime
 * Node. Satori est figé en 0.32.0 : à partir de 0.33, il met en forme le texte
 * avec harfbuzzjs, qui lit son hb.wasm sur le disque — fichier que Vercel
 * n'embarque pas dans la fonction. Voir la section « Aperçu de partage » du
 * README avant de relever cette dépendance.
 */
import { SITE_ORIGIN, fetchPlace, idFromSlug } from '../lib/place.js';
import { cardElement } from '../lib/card.js';
import { cardFonts } from '../lib/font.js';

const CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

export default {
  async fetch(request) {
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

      // Le corps est lu ici plutôt que transmis en flux : le rendu est
      // asynchrone, et sans cette lecture une erreur ne remonterait pas — on
      // servirait un en-tête image/png vide.
      return new Response(png, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(png.length), 'cache-control': CACHE },
      });
    } catch (err) {
      // Jamais d'image cassée : on retombe sur l'aperçu générique du site.
      return new Response(null, {
        status: 302,
        headers: { location: '/og-image.png', 'cache-control': 'public, max-age=300' },
      });
    }
  },
};
