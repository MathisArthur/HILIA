#!/usr/bin/env node
/**
 * Génère data/places.json : les fiches HILIA approuvées, dans un format compact.
 *
 * Pourquoi : le site téléchargeait jusqu'ici les 54 000 fiches depuis Supabase à
 * chaque visite (109 requêtes, ~67 Mo de JSON, ~5 Mo compressés), ce qui pèse
 * autant sur le visiteur que sur le quota Supabase. Ce script produit à la place
 * un seul fichier statique, servi par le CDN Vercel, small et cacheable.
 *
 * Usage :
 *   node scripts/build-dataset.mjs
 *
 * À relancer après chaque import ou modification en masse des fiches,
 * puis à committer : le fichier est déployé comme un actif statique.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lokplzdkvzilsuuqflsk.supabase.co';
// Clé publique (publishable) : elle est déjà présente dans index.html, elle ne
// donne accès qu'à ce que les politiques RLS autorisent à un visiteur anonyme.
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_86IcrAhzRoOkZZn-KGKe6A_6-_FO0B0';
const PAGE = 1000; // max-rows par défaut de PostgREST
const ROOT = new URL('../', import.meta.url);

const HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function page(select, extraQuery, from) {
  const url = `${SUPABASE_URL}/rest/v1/hilia_places?select=${encodeURIComponent(select)}${extraQuery}&order=id.asc`;
  const res = await fetch(url, { headers: { ...HEADERS, Range: `${from}-${from + PAGE - 1}` } });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status} : ${await res.text()}`);
  return res.json();
}

/** Lit un tableau littéral JS (colonne BASE_COLS, liste des activités) depuis app.js. */
function extractArrayLiteral(source, pattern, label) {
  const m = source.match(pattern);
  if (!m) throw new Error(`Impossible de trouver ${label} dans app.js`);
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    try {
      return JSON.parse(m[1].replace(/'/g, '"'));
    } catch (e2) {
      throw new Error(`Lecture de ${label} impossible : ${e.message}`);
    }
  }
}

const appSource = await readFile(new URL('app.js', ROOT), 'utf8');
const BASE_COLS = extractArrayLiteral(appSource, /var BASE_COLS=(\[[^\]]*\])/, 'BASE_COLS');
const ACTIVITES_BASE = extractArrayLiteral(appSource, /activites:(\[[^\]]*\])/, 'la liste des activités');
if (BASE_COLS[0] !== 'name') throw new Error('BASE_COLS[0] doit rester « name » (index utilisé par le sitemap).');
const I_COM = BASE_COLS.indexOf('commune');
const I_ACT = BASE_COLS.indexOf('activity');

console.log(`Colonnes : ${BASE_COLS.length} · activités de référence : ${ACTIVITES_BASE.length}`);

// ---------- Fiches ----------
const rows = [];
for (let from = 0; ; from += PAGE) {
  const batch = await page(`id,${BASE_COLS.join(',')}`, '&status=eq.approved', from);
  rows.push(...batch);
  process.stdout.write(`\rFiches récupérées : ${rows.length}`);
  if (batch.length < PAGE) break;
}
process.stdout.write('\n');
if (!rows.length) throw new Error('Aucune fiche approuvée récupérée : arrêt pour ne pas écraser le fichier.');

// ---------- Dictionnaires ----------
const ACTIVITES = ACTIVITES_BASE.slice();
const actIndex = new Map(ACTIVITES.map((n, i) => [n, i]));
const communes = [];
const comIndex = new Map();
for (const r of rows) {
  if (!comIndex.has(r.commune || '')) {
    comIndex.set(r.commune || '', communes.length);
    communes.push(r.commune || '');
  }
  if (!actIndex.has(r.activity || '')) {
    actIndex.set(r.activity || '', ACTIVITES.length);
    ACTIVITES.push(r.activity || '');
  }
}

// ---------- Lignes compactes : [id, ...40 valeurs] ----------
const encoded = rows.map((r) => {
  const out = new Array(BASE_COLS.length + 1);
  out[0] = r.id;
  for (let i = 0; i < BASE_COLS.length; i++) {
    if (i === I_COM) out[i + 1] = comIndex.get(r.commune || '');
    else if (i === I_ACT) out[i + 1] = actIndex.get(r.activity || '');
    else {
      const v = r[BASE_COLS[i]];
      out[i + 1] = v === undefined ? null : v;
    }
  }
  return out;
});

// ---------- Données détaillées (rare) : access / qualif ----------
async function sparse(col) {
  const out = {};
  for (let from = 0; ; from += PAGE) {
    const batch = await page(`id,${col}`, `&${col}=not.is.null`, from);
    batch.forEach((r) => { if (r[col] != null) out[r.id] = r[col]; });
    if (batch.length < PAGE) break;
  }
  return out;
}
const access = await sparse('access');
const qualif = await sparse('qualif');

// ---------- Écriture ----------
const payload = {
  v: 1,
  generatedAt: new Date().toISOString(),
  count: encoded.length,
  communes,
  activites: ACTIVITES,
  access,
  qualif,
  rows: encoded,
};
const json = JSON.stringify(payload);
await writeFile(new URL('data/places.json', ROOT), json);

// ---------- Sitemap ----------
// Une fiche = une URL réelle (/lieu/<slug>) : le slug doit être calculé exactement
// comme dans app.js (makePlaceSlug). Toute modification de cette fonction doit
// être reportée ici, et inversement.
const SITE = 'https://www.hilia.fr';
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;
// Convention d'affichage du site : un tiret simple, jamais de tiret cadratin.
// Le slug est inchangé (toute ponctuation devient déjà un tiret), mais le nom
// écrit dans le jeu de données l'est aussi.
const EM_DASH = /\u2014/g;
const tidy = (v) => String(v == null ? '' : v).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().replace(EM_DASH, '-');
const slugify = (s) => tidy(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const placeSlug = (name, id) => (slugify(name) || 'lieu') + '-' + (slugify(String(id)) || 'fiche');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = new Date().toISOString().slice(0, 10);
const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
const urlEntry = (loc, priority) => `<url><loc>${esc(loc)}</loc><lastmod>${today}</lastmod><priority>${priority}</priority></url>`;

const PAGES = [
  ['/', '1.0'], ['/prestataires', '0.8'], ['/a-propos', '0.6'], ['/faq', '0.6'],
  ['/contact', '0.4'], ['/accessibilite', '0.4'], ['/mentions-legales', '0.3'],
  ['/confidentialite', '0.3'], ['/cgu', '0.3'], ['/cookies', '0.3'], ['/plan-du-site', '0.3'],
];
await writeFile(
  new URL('sitemap-pages.xml', ROOT),
  xml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + PAGES.map(([p, prio]) => urlEntry(SITE + p, prio)).join('') + '</urlset>')
);

const CHUNK = 45000; // limite d’un fichier sitemap : 50 000 URL
const names = rows.map((r) => ({ name: tidy(r.name), id: r.id }));
const chunks = [];
for (let i = 0; i < names.length; i += CHUNK) {
  const file = `sitemap-lieux-${chunks.length + 1}.xml`;
  const urls = names.slice(i, i + CHUNK).map((n) => urlEntry(`${SITE}/lieu/${placeSlug(n.name, n.id)}`, '0.6')).join('');
  await writeFile(new URL(file, ROOT), xml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + '</urlset>'));
  chunks.push(file);
}
await writeFile(
  new URL('sitemap.xml', ROOT),
  xml('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ['sitemap-pages.xml', ...chunks].map((f) => `<sitemap><loc>${SITE}/${f}</loc><lastmod>${today}</lastmod></sitemap>`).join('') + '</sitemapindex>')
);
console.log(`Sitemap : ${PAGES.length} pages · ${names.length} fiches dans ${chunks.length} fichier(s)`);

const mo = (n) => `${(n / 1048576).toFixed(2)} Mo`;
console.log(`data/places.json : ${mo(json.length)} brut · ${mo(gzipSync(json).length)} compressé`);
console.log(`${encoded.length} fiches · ${communes.length} communes · ${ACTIVITES.length} activités · ${Object.keys(access).length} fiches qualifiées`);
