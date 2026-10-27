/**
 * Carte d'aperçu (image de partage) d'une fiche, décrite en éléments React
 * « à la main » : pas de JSX, donc pas d'étape de compilation.
 *
 * Le rendu est assuré par @vercel/og (Satori + Resvg) : seules les propriétés
 * flexbox sont prises en charge, d'où une mise en page volontairement simple.
 */
import { criteriaOf } from './place.js';

const h = (type, style, children) => ({ type, props: { style, children } });

const TEAL = '#064647';
const AMBER = '#FEB31E';
const CREAM = '#F8F3E8';
const INK = '#183A3A';
const MUTED = '#5D726F';

function nameSize(name) {
  const n = name.length;
  if (n <= 30) return 88;
  if (n <= 46) return 74;
  if (n <= 64) return 62;
  return 52;
}

export function cardElement(place) {
  const criteria = criteriaOf(place).slice(0, 3);
  const extra = Math.max(0, criteriaOf(place).length - criteria.length);
  const where = [place.commune, place.cp ? `(${place.cp})` : ''].filter(Boolean).join(' ');

  return h(
    'div',
    {
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      backgroundColor: CREAM,
      padding: '52px 64px 44px',
      color: INK,
      // Aucune famille nommée : Vercel dessine avec sa police par défaut. En
      // local, scripts/preview-card.mjs fournit Geist et Satori l'utilise.
    },
    [
      h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
        h('div', { display: 'flex', alignItems: 'center' }, [
          h('div', { width: 14, height: 46, borderRadius: 4, backgroundColor: AMBER, marginRight: 18 }, ''),
          h('div', { fontSize: 40, fontWeight: 700, letterSpacing: 6, color: TEAL }, 'HILIA'),
        ]),
        place.activity
          ? h(
              'div',
              {
                display: 'flex',
                backgroundColor: TEAL,
                color: '#FFFFFF',
                fontSize: 23,
                padding: '10px 24px',
                borderRadius: 999,
                maxWidth: 520,
                overflow: 'hidden',
              },
              place.activity
            )
          : h('div', { display: 'flex' }, ''),
      ]),

      h('div', { display: 'flex', flexDirection: 'column' }, [
        h(
          'div',
          {
            display: 'flex',
            fontSize: nameSize(place.name),
            fontWeight: 700,
            letterSpacing: -1,
            lineHeight: 1.06,
            color: INK,
            maxHeight: 260,
            overflow: 'hidden',
          },
          place.name
        ),
        where
          ? h('div', { display: 'flex', fontSize: 32, color: MUTED, marginTop: 18 }, where)
          : h('div', { display: 'flex' }, ''),
      ]),

      h('div', { display: 'flex', flexDirection: 'column' }, [
        h(
          'div',
          { display: 'flex', flexWrap: 'wrap', alignItems: 'center' },
          criteria.length
            ? [
                ...criteria.map((label) =>
                  h(
                    'div',
                    {
                      display: 'flex',
                      border: `2px solid ${TEAL}`,
                      color: TEAL,
                      fontSize: 22,
                      padding: '8px 20px',
                      borderRadius: 999,
                      marginRight: 12,
                      marginBottom: 10,
                    },
                    label
                  )
                ),
                extra > 0
                  ? h('div', { display: 'flex', fontSize: 22, color: MUTED }, `+${extra} critère${extra > 1 ? 's' : ''}`)
                  : h('div', { display: 'flex' }, ''),
              ]
            : [h('div', { display: 'flex', fontSize: 24, color: MUTED }, 'Informations d’accessibilité déclaratives')]
        ),
        h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }, [
          h('div', { display: 'flex', fontSize: 25, fontWeight: 700, color: TEAL }, 'hilia.fr'),
          h('div', { display: 'flex', fontSize: 22, color: MUTED }, 'Rendre le loisir accessible à tous'),
        ]),
      ]),
    ]
  );
}
