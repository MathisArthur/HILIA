/**
 * Politique du proxy d'images.
 *
 * Le navigateur ne charge jamais directement les domaines des producteurs :
 * /api/media ne relaie que les hôtes réellement présents dans les médias
 * éligibles, refuse les adresses privées et revalide chaque redirection.
 */
import { lookup } from 'node:dns/promises';

const MAX_REDIRECTS = 3;
const dnsCache = new Map();
const DNS_TTL = 5 * 60 * 1000;

export function isPrivateIp(address) {
  const ip = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(ip)) return true; // multicast
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast/réservé
  return false;
}

export function isAllowedMediaUrl(raw, allowedHosts) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.port && u.port !== '80' && u.port !== '443') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    return allowedHosts instanceof Set ? allowedHosts.has(host) : Array.isArray(allowedHosts) && allowedHosts.includes(host);
  } catch {
    return false;
  }
}

export async function assertPublicHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) throw new Error('Hôte absent');
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && now - cached.at < DNS_TTL) {
    if (cached.private) throw new Error('Adresse privée refusée');
    return cached.addresses;
  }
  const rows = await lookup(host, { all: true, verbatim: true });
  const addresses = rows.map((r) => r.address);
  if (!addresses.length || addresses.some(isPrivateIp)) {
    dnsCache.set(host, { at: now, private: true, addresses });
    throw new Error('Adresse privée refusée');
  }
  dnsCache.set(host, { at: now, private: false, addresses });
  return addresses;
}

/** Suit les redirections en revalidant l'hôte et l'adresse à chaque étape. */
export async function fetchMedia(raw, allowedHosts, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
  let current = new URL(String(raw));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedMediaUrl(current.href, allowedHosts)) throw new Error('Média non autorisé');
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/avif,image/webp,image/*;q=0.8', 'user-agent': 'HILIA-media/1.0' },
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirection sans destination');
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) throw new Error(`Source HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error('Format non image');
    const announced = Number(res.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > maxBytes) throw new Error('Image trop volumineuse');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new Error('Image trop volumineuse');
    return { body, type, finalUrl: current.href };
  }
  throw new Error('Trop de redirections');
}
