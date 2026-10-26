/**
 * Logique partagée par les fonctions Vercel :
 *   - lire une fiche approuvée à partir de son slug ;
 *   - construire l'aperçu social (image et métadonnées).
 *
 * Aucun secret ici : la clé publishable est publique et ne donne accès qu'à ce
 * que les politiques RLS autorisent à un visiteur anonyme.
 */

export const SUPABASE_URL = 'https://lokplzdkvzilsuuqflsk.supabase.co';
// Domaine de référence : les URL canoniques ne dépendent pas du domaine d’accès
// (une préversion *.vercel.app ne doit pas créer de doublons).
export const SITE_ORIGIN = 'https://www.hilia.fr';
export const SUPABASE_KEY = 'sb_publishable_86IcrAhzRoOkZZn-KGKe6A_6-_FO0B0';

const COLUMNS = [
  'id', 'name', 'commune', 'cp', 'activity', 'site',
  'entree_plain_pied', 'entree_rampe', 'entree_ascenseur',
  'stationnement_pmr', 'sanitaires_pmr', 'accueil_personnel',
].join(',');

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;

export const tidy = (v) => String(v == null ? '' : v).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

// Même convention que le site : les colonnes booléennes valent 1, true ou "True".
export const isTrue = (v) => v === 1 || v === true || v === 'True';

/** Le slug se termine toujours par l'identifiant de la fiche : « piscine-a-serent-48171 ». */
export function idFromSlug(slug) {
  const m = /-(\d+)\/?$/.exec(String(slug || ''));
  return m ? m[1] : null;
}

/** Les critères d'accessibilité mis en avant sur l'image, dans l'ordre d'importance. */
const CRITERIA = [
  ['entree_plain_pied', 'Entrée de plain-pied'],
  ['entree_rampe', 'Rampe d’accès'],
  ['entree_ascenseur', 'Ascenseur'],
  ['stationnement_pmr', 'Stationnement PMR'],
  ['sanitaires_pmr', 'Sanitaires PMR'],
  ['accueil_personnel', 'Accueil sur place'],
];

export function criteriaOf(place) {
  return CRITERIA.filter(([key]) => isTrue(place[key])).map(([, label]) => label);
}

/** Résumé textuel des critères, pour la description de la page. */
export function summaryOf(place) {
  const labels = criteriaOf(place).map((l) => l.toLowerCase());
  return labels.length ? labels.join(', ') : 'informations d’accessibilité déclaratives';
}

/** Lit une fiche approuvée. Renvoie null si elle n'existe pas (ou n'est plus publiée). */
export async function fetchPlace(id) {
  if (!id) return null;
  const url = `${SUPABASE_URL}/rest/v1/hilia_places?select=${COLUMNS}&status=eq.approved&id=eq.${encodeURIComponent(id)}&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    name: tidy(row.name) || 'Lieu',
    commune: tidy(row.commune),
    cp: tidy(row.cp),
    activity: tidy(row.activity),
  };
}

const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Nom affiché, sans répéter la commune quand le nom la contient déjà. */
export function titleOf(place) {
  const inline = place.commune && strip(place.name).includes(strip(place.commune));
  return inline || !place.commune ? place.name : `${place.name} à ${place.commune}`;
}
const strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function pageTitle(place) {
  return `${titleOf(place)} — accessibilité | HILIA`;
}

export function pageDescription(place) {
  const where = place.commune ? ` à ${place.commune}` : '';
  const cp = place.cp ? ` (${place.cp})` : '';
  return `Accessibilité de ${place.name}${where}${cp} : ${summaryOf(place)}. Stationnement, entrée, accueil et sanitaires sur HILIA.`;
}

export function ogImageUrl(slug) {
  return `${SITE_ORIGIN}/api/og?s=${encodeURIComponent(slug)}`;
}

export function canonicalUrl(slug) {
  return `${SITE_ORIGIN}/lieu/${encodeURIComponent(slug)}`;
}

/** Remplace le contenu d'une balise meta, ou l'ajoute avant </head>. */
function setMeta(html, attr, name, value) {
  const re = new RegExp(`(<meta ${attr}="${name}" content=")[^"]*(")`);
  if (re.test(html)) return html.replace(re, (_m, a, b) => a + escapeAttr(value) + b);
  return html.replace('</head>', `  <meta ${attr}="${name}" content="${escapeAttr(value)}">\n</head>`);
}

/**
 * Injecte, dans le HTML de l'application, les métadonnées propres à une fiche.
 * Le HTML n'est jamais réécrit côté navigateur : cette fonction tourne côté
 * serveur, seul endroit où les robots des réseaux sociaux acceptent de lire.
 */
export function injectMeta(html, place, slug) {
  const title = pageTitle(place);
  const description = pageDescription(place);
  const url = canonicalUrl(slug);
  const image = ogImageUrl(slug);

  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)}</title>`);
  out = setMeta(out, 'name', 'description', description);
  out = setMeta(out, 'property', 'og:title', title);
  out = setMeta(out, 'property', 'og:description', description);
  out = setMeta(out, 'property', 'og:image', image);
  out = setMeta(out, 'property', 'og:image:alt', `${titleOf(place)} — aperçu HILIA`);
  out = setMeta(out, 'name', 'twitter:title', title);
  out = setMeta(out, 'name', 'twitter:description', description);
  out = setMeta(out, 'name', 'twitter:image', image);

  const head = [
    `<link rel="canonical" href="${escapeAttr(url)}">`,
    `<meta property="og:url" content="${escapeAttr(url)}">`,
  ].join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: place.name,
    url,
    description,
    ...(place.commune || place.cp
      ? {
          address: {
            '@type': 'PostalAddress',
            addressLocality: place.commune,
            postalCode: place.cp,
            addressCountry: 'FR',
          },
        }
      : {}),
  };

  return out.replace(
    '</head>',
    `${head}\n<script type="application/ld+json" id="placeJsonLd">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n</head>`
  );
}
