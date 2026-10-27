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
 *
 * Forme d'export : Vercel attend, pour une fonction de /api, soit un objet
 * `{ fetch(request) }` (standard Web), soit un export par méthode (`GET`), soit
 * la signature Node `(request, response)`. Un simple `export default function`
 * est traité comme un handler Node, où l'URL reçue est relative : d'où l'objet
 * `fetch` ci-dessous.
 */
import { SITE_ORIGIN, fetchPlace, idFromSlug, injectMeta } from '../lib/place.js';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // Le contenu ne change qu'à la modification d'une fiche.
  'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
};

export default {
  async fetch(request) {
    // Avec l'export `fetch`, request.url est absolu ; la base ne sert qu'à rester
    // tolérant si l'URL arrive relative (serveur local notamment).
    const url = new URL(request.url, SITE_ORIGIN);
    const slug = url.searchParams.get('slug') || '';

    let html = null;
    try {
      // Le socle de l'application, pris à la racine : depuis cleanUrls,
      // /index.html redirige vers / et coûterait un aller-retour de plus.
      const res = await fetch(new URL('/', url), { headers: { 'user-agent': 'HILIA-meta' } });
      if (res.ok) html = await res.text();
    } catch (err) {
      html = null;
    }
    // Sans le socle de l'application, inutile de servir une page vide.
    if (!html) return new Response(null, { status: 302, headers: { location: '/' } });

    try {
      const place = await fetchPlace(idFromSlug(slug));
      // Fiche inconnue ou retirée : l'application s'affiche quand même (elle
      // nettoiera l'URL), mais le refus est dit clairement aux moteurs. Répondre
      // 200 ferait de chaque adresse inventée après /lieu/ une page valable à
      // leurs yeux : autant de doublons de l'accueil à indexer.
      if (!place) return new Response(html, { status: 404, headers: HTML_HEADERS });
      return new Response(injectMeta(html, place, slug), { status: 200, headers: HTML_HEADERS });
    } catch (err) {
      return new Response(html, { status: 200, headers: HTML_HEADERS });
    }
  },
};
