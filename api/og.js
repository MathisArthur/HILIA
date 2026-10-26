/**
 * Image d'aperçu (Open Graph) d'une fiche : /api/og?s=<slug>
 *
 * Rendue par @vercel/og (Satori + Resvg). Les robots des réseaux sociaux ne
 * lisent pas le JavaScript : c'est api/place.js qui place cette adresse dans le
 * <head> de la page, côté serveur.
 */
import { ImageResponse } from '@vercel/og';
import { fetchPlace, idFromSlug } from './_lib/place.js';
import { cardElement } from './_lib/card.js';

export default async function handler(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('s') || '';

  try {
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
}
