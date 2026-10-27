/**
 * Serveur de test local : rejoue les en-têtes, les réécritures et les fonctions
 * de `vercel.json`, pour vérifier le site exactement comme en production.
 *
 *   node scripts/dev-server.mjs   ->   http://127.0.0.1:8787
 *
 * Les fonctions de /api sont exécutées telles quelles (elles reçoivent un
 * `Request` et renvoient un `Response`). Seule exception : /api/og, qui dépend
 * d'un module WebAssembly fourni par Vercel et retombe donc, en local, sur
 * l'image générique. Pour voir une carte générée :
 *
 *   npm i --no-save satori @resvg/resvg-js && node scripts/preview-card.mjs
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
const root = process.cwd();
const port = 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// Les motifs de vercel.json sont déjà des expressions régulières ; seuls les
// paramètres « :slug » doivent être convertis.
const toRe = (source) => new RegExp('^' + source.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '$');

function headersFor(pathname) {
  const out = {};
  for (const rule of cfg.headers || []) {
    if (toRe(rule.source).test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

function rewriteFor(pathname) {
  for (const rule of cfg.rewrites || []) {
    const m = pathname.match(toRe(rule.source));
    if (!m) continue;
    const params = m.groups || {};
    const dest = rule.destination.replace(/:([a-zA-Z]+)/g, (_all, key) => encodeURIComponent(params[key] || ''));
    return { dest };
  }
  return null;
}

async function fileFor(rel) {
  const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(root, clean);
  try {
    const st = await stat(full);
    if (st.isDirectory()) return (await stat(path.join(full, 'index.html'))).isFile() ? path.join(full, 'index.html') : null;
    return st.isFile() ? full : null;
  } catch { return null; }
}

/** Exécute une fonction de /api comme le ferait Vercel. */
async function runApi(dest, req, res, extraHeaders) {
  const [pathPart, query] = dest.split('?');
  const name = pathPart.replace(/^\/api\//, '').replace(/\.js$/, '');
  // @vercel/og s'appuie sur des modules WebAssembly fournis par la plateforme de
  // déploiement : en local, on sert l'image générique (voir scripts/preview-card.mjs
  // pour générer une carte réelle).
  if (name === 'og') {
    res.writeHead(302, { location: '/og-image.png' });
    res.end();
    return;
  }

  const url = `http://${req.headers.host}${pathPart}${query ? '?' + query : ''}`;
  try {
    const mod = await import('../api/' + name + '.js');
    // Vercel appelle l'export `fetch` (standard Web) ; on fait de même.
    const handler = typeof mod.default === 'function' ? mod.default : mod.default.fetch.bind(mod.default);
    const request = new Request(url, { method: req.method || 'GET', headers: req.headers });
    const response = await handler(request);
    const body = Buffer.from(await response.arrayBuffer());
    const headers = { ...Object.fromEntries(response.headers), ...extraHeaders };
    res.writeHead(response.status, headers);
    res.end(body);
  } catch (err) {
    console.error('Fonction /api/' + name + ' :', err.message);
    if (name === 'og') {
      res.writeHead(302, { location: '/og-image.png' });
      res.end();
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Fonction indisponible : ' + err.message);
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const headers = headersFor(pathname);

  let file = await fileFor(pathname);
  if (!file) {
    const rw = rewriteFor(pathname);
    if (rw && rw.dest.startsWith('/api/')) { await runApi(rw.dest, req, res, headers); return; }
    if (rw) file = await fileFor(rw.dest);
  }
  const isApi = !file && /^\/api\//.test(pathname);
  if (isApi) { await runApi(pathname + url.search, req, res, headers); return; }

  let status = 200;
  if (!file) { file = await fileFor('/404.html'); status = 404; }
  if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('introuvable'); return; }
  const body = await readFile(file);
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...headers });
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
