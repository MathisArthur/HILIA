/**
 * Image d'aperçu (Open Graph) d'une fiche : /api/og?s=<slug>
 *
 * Rendue par @vercel/og (Satori + Resvg). Les robots des réseaux sociaux ne
 * lisent pas le JavaScript : c'est api/place.js qui place cette adresse dans le
 * <head> de la page, côté serveur.
 *
 * Forme d'export : objet `{ fetch(request) }` (standard Web), comme api/place.js.
 * L'import de @vercel/og est volontairement placé dans le try : si la
 * bibliothèque ne peut pas être chargée, on renvoie l'aperçu générique plutôt
 * qu'une erreur serveur.
 */
import { SITE_ORIGIN, fetchPlace, idFromSlug } from '../lib/place.js';
import { cardElement } from '../lib/card.js';

export default {
  async fetch(request) {
    try {
      const { ImageResponse } = await import('@vercel/og');
      const url = new URL(request.url, SITE_ORIGIN);
      const slug = url.searchParams.get('s') || '';

      const place = await fetchPlace(idFromSlug(slug));
      if (!place) throw new Error('fiche introuvable');

      return new ImageResponse(cardElement(place), {
        width: 1200,
        height: 630,
        headers: {
          // L'image ne change qu'à la modification d'une fiche : cache long.
          'cache-control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        },
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
