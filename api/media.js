/**
 * Proxy d'images des producteurs de données.
 *
 * Pourquoi : la CSP du site n'autorise que 'self'. Ouvrir img-src à tous les
 * domaines reviendrait à accepter n'importe quelle origine ; ce proxy ne relaie
 * que les hôtes réellement présents dans les médias éligibles, et refuse les
 * adresses privées ainsi que les redirections hors liste.
 *
 * Forme d'export Vercel : { fetch(request) }.
 */
import { MEDIA_HOSTS } from '../lib/media-hosts.js';
import { fetchMedia, isAllowedMediaUrl } from '../lib/media-policy.js';

const CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800';

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Méthode non autorisée', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url, 'https://www.hilia.fr');
    const raw = url.searchParams.get('u');
    if (!raw || !isAllowedMediaUrl(raw, MEDIA_HOSTS)) {
      return new Response('Média non autorisé', { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    try {
      const { body, type, finalUrl } = await fetchMedia(raw, MEDIA_HOSTS);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': type,
          'content-length': String(body.length),
          'cache-control': CACHE,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-media-source': finalUrl.slice(0, 200),
        },
      });
    } catch (error) {
      // Le détail (DNS, format, taille) ne doit pas devenir un oracle SSRF.
      console.warn('Média indisponible', String(error?.message || error).slice(0, 160));
      return new Response('Média indisponible', { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  },
};
