#!/usr/bin/env node
/**
 * Écrit les onze pages du site (/a-propos.html, /faq.html, ...) à partir de
 * index.html, en y injectant le titre, la description et l'adresse canonique
 * propres à chacune.
 *
 * Pourquoi : le titre de chaque page n'était posé que par le navigateur
 * (`document.title`, dans app.js). Les onze URL se présentaient donc aux moteurs
 * de recherche sous le même titre et sans canonique, ce qui retarde leur
 * indexation. Désormais le HTML servi contient déjà la bonne métadonnée.
 *
 * Usage :
 *   npm run pages
 *
 * À relancer après toute modification de PAGE_META ou PAGE_PATHS dans app.js,
 * puis à committer : ces fichiers sont déployés comme des actifs statiques, et
 * Vercel les sert sous /a-propos, /faq, ... (cleanUrls, voir vercel.json).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { injectPageMeta, SITE_ORIGIN } from '../lib/place.js';

const ROOT = new URL('../', import.meta.url);
const shell = await readFile(new URL('index.html', ROOT), 'utf8');
const app = await readFile(new URL('app.js', ROOT), 'utf8');

// app.js reste la seule source de vérité : les métadonnées y sont déjà écrites,
// on les relit au lieu de les recopier ici (même principe que BASE_COLS dans
// scripts/build-dataset.mjs). Une page ajoutée dans app.js doit apparaître ici
// sans autre intervention.
function literal(source, pattern, label) {
  const m = source.match(pattern);
  if (!m) throw new Error(`Impossible de trouver ${label} dans app.js`);
  return m;
}

const metaBlock = literal(app, /var PAGE_META=\{([\s\S]*?)\n\s*\};/, 'PAGE_META');
const PAGE_META = {};
for (const [, key, title, description] of metaBlock[1].matchAll(
  /(\w+):\s*\{title:'([^']*)',description:'([^']*)'\}/g
)) {
  PAGE_META[key] = { title, description };
}

const pathsBlock = literal(app, /var PAGE_PATHS=(\{[^}]*\})/, 'PAGE_PATHS');
const PAGE_PATHS = JSON.parse(pathsBlock[1].replace(/'/g, '"'));

const pages = Object.entries(PAGE_PATHS);
if (pages.length !== Object.keys(PAGE_META).length) {
  throw new Error(`PAGE_PATHS décrit ${pages.length} pages, PAGE_META en décrit ${Object.keys(PAGE_META).length}.`);
}

// La page d'accueil est index.html elle-même : elle n'est pas générée, mais son
// titre doit rester identique à celui que le navigateur applique en revenant
// dessus, sinon l'accueil changerait de titre en cours de visite.
const home = PAGE_META[Object.keys(PAGE_PATHS).find((k) => PAGE_PATHS[k] === '/')];
const staticTitle = (shell.match(/<title>([^<]*)<\/title>/) || [])[1];
const staticDescription = (shell.match(/<meta name="description" content="([^"]*)"/) || [])[1];
if (staticTitle !== home.title) {
  throw new Error(`index.html : titre « ${staticTitle} » différent de PAGE_META (« ${home.title} »).`);
}
if (staticDescription !== home.description) {
  throw new Error(`index.html : description différente de PAGE_META.`);
}

// ---------- Écriture des onze pages ----------
const written = [];
for (const [page, path] of pages) {
  if (path === '/') continue;
  const meta = PAGE_META[page];
  // Le profil est personnel : il ne doit pas être indexé, comme côté navigateur.
  const robots = page === 'profile' ? 'noindex,follow' : 'index,follow';
  const html = injectPageMeta(shell, {
    title: meta.title,
    description: meta.description,
    url: SITE_ORIGIN + path,
    robots,
  });
  const file = path.replace(/^\//, '') + '.html';
  await writeFile(new URL(file, ROOT), html);
  written.push({ file, path, robots });
}

// ---------- Cohérence avec le sitemap ----------
// Une page indexable absente du sitemap (ou une page non indexable présente
// dedans) est une erreur silencieuse : on la refuse plutôt que de la déployer.
const sitemap = await readFile(new URL('sitemap-pages.xml', ROOT), 'utf8');
const declared = new Set([...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]));
for (const { path, robots } of written) {
  const url = SITE_ORIGIN + path;
  if (robots.startsWith('index') && !declared.has(url)) throw new Error(`${url} est indexable mais absent de sitemap-pages.xml.`);
  if (robots.startsWith('noindex') && declared.has(url)) throw new Error(`${url} est en noindex mais présent dans sitemap-pages.xml.`);
}

for (const { file, path, robots } of written) {
  console.log(`${file.padEnd(24)} -> ${path.padEnd(18)} ${robots}`);
}
console.log(`\n${written.length} pages écrites · accueil inchangé (index.html) · sitemap cohérent`);
