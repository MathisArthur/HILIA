/**
 * Vérifie que le rendu d'une carte d'aperçu ne lit AUCUN fichier `.wasm` sur le
 * disque — c'est la condition pour qu'il fonctionne sur Vercel, où un fichier
 * que le traceur n'embarque pas est tout simplement absent de la fonction.
 *
 *   node scripts/check-card.mjs
 *
 * À relancer après tout changement de version de Satori : à partir de 0.33, il
 * met en forme le texte avec harfbuzzjs, qui lit `hb.wasm` sur le disque et
 * fait retomber l'aperçu sur l'image générique (voir le README).
 */
import fs from 'node:fs';
import path from 'node:path';

const isWasm = (p) => String(p).endsWith('.wasm');
const attempts = [];
const readSync = fs.readFileSync;
fs.readFileSync = (p, ...rest) => {
  if (isWasm(p)) { attempts.push(String(p)); throw new Error('lecture .wasm interdite : ' + p); }
  return readSync(p, ...rest);
};
const { readFile } = fs.promises;
fs.promises.readFile = (p, ...rest) => {
  if (isWasm(p)) { attempts.push(String(p)); return Promise.reject(new Error('lecture .wasm interdite : ' + p)); }
  return readFile(p, ...rest);
};

const satori = (await import('satori')).default;
const { Resvg } = await import('@resvg/resvg-js');
const { cardElement } = await import('../lib/card.js');
const { cardFonts } = await import('../lib/font.js');

const place = {
  name: 'Centre aquatique intercommunal du Pays de Brocéliande — piscine et espace bien-être',
  commune: 'Sérent', cp: '56460', activity: 'Piscine, centre aquatique',
  entree_plain_pied: 1, stationnement_pmr: 1, sanitaires_pmr: 'True',
};

const fonts = await cardFonts();
const svg = await satori(cardElement(place), { width: 1200, height: 630, fonts });
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

const out = 'og-preview';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'controle.png'), png);

console.log('carte dessinée :', png.length, 'octets —', out + '/controle.png');
console.log('polices :', fonts.map((f) => f.name + ' ' + f.weight).join(', '));
console.log('lectures .wasm :', attempts.length ? 'ÉCHEC — ' + attempts.join(', ') : 'aucune');
process.exit(attempts.length ? 1 : 0);
