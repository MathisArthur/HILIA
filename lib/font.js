/**
 * Police des images d'aperçu : Archivo, celle des titres du site.
 *
 * Satori a besoin des octets d'une police, et n'accepte pas le woff2 (que
 * Google Fonts sert aux navigateurs modernes). On demande donc la feuille de
 * style à Google avec un agent ancien : il répond alors par des polices ttf
 * complètes, une par graisse, sans unicode-range. Les sous-ensembles ne sont
 * filtrés que si le serveur en renvoie (auquel cas on garde le latin, celui
 * qui contient les accents français).
 *
 * La police est mise en cache pour la durée de vie de l'instance : une seule
 * paire de requêtes par instance, pas une par image. En cas d'échec réseau, la
 * promesse est oubliée pour que l'appel suivant réessaie.
 */
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;700&display=swap';
const FAMILY = 'Archivo';

// Un sous-ensemble latin commence à U+0000 (latin-ext commence à U+0100).
const isLatin = (block) => /unicode-range:[^;]*U\+0000/i.test(block);

let cached = null;

async function download() {
  const cssRes = await fetch(CSS_URL, { headers: { 'user-agent': 'Mozilla/4.0' } });
  if (!cssRes.ok) throw new Error('Google Fonts : HTTP ' + cssRes.status);
  const blocks = (await cssRes.text()).split('@font-face').slice(1);
  // Si le serveur découpe en sous-ensembles, ne garder que le latin.
  const usable = blocks.some((b) => /unicode-range/i.test(b)) ? blocks.filter(isLatin) : blocks;
  if (!usable.length) throw new Error('Google Fonts : police introuvable');

  const fonts = await Promise.all(
    usable.map(async (block) => {
      const url = (block.match(/url\((https:\/\/[^)]+)\)/) || [])[1];
      const weight = Number((block.match(/font-weight:\s*(\d+)/) || [])[1]) || 400;
      if (!url) throw new Error('Google Fonts : adresse de police introuvable');
      const res = await fetch(url);
      if (!res.ok) throw new Error('Google Fonts : police HTTP ' + res.status);
      return { name: FAMILY, data: Buffer.from(await res.arrayBuffer()), weight, style: 'normal' };
    })
  );
  return fonts;
}

/** Renvoie la liste de polices attendue par Satori. */
export async function cardFonts() {
  if (!cached) {
    cached = download();
    // Un échec ne doit pas rester en cache : l'appel suivant retentera.
    cached.catch(() => { cached = null; });
  }
  return cached;
}

export const FONT_FAMILY = FAMILY;
