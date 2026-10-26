/**
 * Génère des exemples de cartes de partage (celles que produit /api/og) pour en
 * vérifier le visuel sans déployer.
 *
 *   npm i --no-save satori @resvg/resvg-js
 *   node scripts/preview-card.mjs
 *
 * Les images sont écrites dans og-preview/ (non versionné). Le rendu utilise le
 * même moteur que @vercel/og (Satori + Resvg) et la même police.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { cardElement } from '../api/_lib/card.js';
import { fetchPlace } from '../api/_lib/place.js';

const OUT = 'og-preview';

// Trois cas de figure : une vraie fiche, un nom très long, une fiche sans
// information d'accessibilité renseignée.
const SAMPLES = [
  { id: '48171' },
  {
    name: 'Centre aquatique intercommunal du Pays de Brocéliande — piscine et espace bien-être',
    commune: 'Sérent', cp: '56460', activity: 'Piscine, centre aquatique',
    entree_plain_pied: 1, stationnement_pmr: 1,
  },
  { name: 'Le Klube', commune: 'Châteauneuf-les-Martigues', cp: '13220', activity: 'Salle de spectacle' },
];

const font = await readFile('./node_modules/@vercel/og/dist/Geist-Regular.ttf');
await mkdir(OUT, { recursive: true });

for (const [i, sample] of SAMPLES.entries()) {
  const place = sample.id ? await fetchPlace(sample.id) : sample;
  if (!place) {
    console.warn('Fiche ' + sample.id + ' introuvable : exemple ignoré.');
    continue;
  }
  const svg = await satori(cardElement(place), {
    width: 1200,
    height: 630,
    fonts: [{ name: 'Geist', data: font, weight: 400, style: 'normal' }],
  });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  const file = path.join(OUT, 'carte-' + (i + 1) + '.png');
  await writeFile(file, png);
  console.log(file, '—', place.name);
}
