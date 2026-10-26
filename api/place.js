/**
 * Page d'une fiche : /lieu/<slug> (réécrite par vercel.json vers /api/place).
 *
 * L'application est un fichier statique unique : sans cette fonction, toutes les
 * fiches partageraient le même titre et la même image d'aperçu, car les robots
 * des réseaux sociaux ne lisent pas le JavaScript. Elle récupère index.html et
 * n'y remplace que le <head>.
 *
 * En cas de panne, la page est servie telle quelle : une fiche doit toujours
 * s'afficher, même sans métadonnées.
 */
import { fetchPlace, idFromSlug, injectMeta } from './_lib/place.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // Le contenu ne change qu'à la modification d'une fiche.
  'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
};

export default async function handler(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';

  let html;
  try {
    const res = await fetch(new URL('/index.html', url), { headers: { 'user-agent': 'HILIA-meta' } });
    if (!res.ok) throw new Error('index.html : HTTP ' + res.status);
    html = await res.text();
  } catch (err) {
    // Sans le socle de l'application, inutile de servir une page vide.
    return new Response(null, { status: 302, headers: { location: '/' } });
  }

  try {
    const place = await fetchPlace(idFromSlug(slug));
    // Fiche inconnue ou retirée : l'application affichera la liste (et l'URL
    // sera nettoyée côté navigateur).
    if (!place) return new Response(html, { status: 200, headers: HTML_HEADERS });
    return new Response(injectMeta(html, place, slug), { status: 200, headers: HTML_HEADERS });
  } catch (err) {
    return new Response(html, { status: 200, headers: HTML_HEADERS });
  }
}
