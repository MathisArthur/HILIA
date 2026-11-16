import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEventDetail,
  buildPlaceDetail,
  descriptionOf,
  extractAccessibility,
  extractEventDates,
  extractHours,
  extractMedia,
  extractPrices,
  tidyText,
  todayIso,
} from '../lib/normalize.mjs';
import { familyOf } from '../lib/categories.mjs';

const TODAY = '2026-11-13';

function record(overrides = {}) {
  return {
    id: 'dt:test',
    kind: 'place',
    name: 'Lieu test',
    description: 'Une description.',
    sources: [{ source: 'datatourisme', source_id: 'https://example.test/1', licence: 'etalab-open-licence', source_updated_at: '2026-01-01' }],
    categories: ['Musée'],
    media: [],
    accessibility_observations: [],
    details_by_source: {
      'datatourisme:https://example.test/1': { details: {} },
    },
    ...overrides,
  };
}

function withDetails(details, overrides = {}) {
  const r = record(overrides);
  r.details_by_source['datatourisme:https://example.test/1'].details = details;
  return r;
}

test('tidyText conserve les paragraphes et retire les caractères invisibles', () => {
  assert.equal(tidyText('  Un\u200b texte\r\n\r\n\r\nSuite  '), 'Un texte\n\nSuite');
  assert.equal(tidyText('Tiret \u2014 cadratin'), 'Tiret - cadratin');
});

test('une description absente reste absente', () => {
  assert.equal(descriptionOf(record({ description: null })), '');
  assert.equal(descriptionOf(record({ description: null, details_by_source: {} })), '');
});

test('les horaires expirés sont écartés, les horaires explicites conservés', () => {
  const r = withDetails({
    'location.schema:openingHoursSpecification': [
      { 'schema:dayOfWeek': 'schema:Monday', 'schema:opens': '09:00', 'schema:closes': '12:00', 'schema:validThrough': '2020-01-01' },
      { 'schema:dayOfWeek': 'schema:Tuesday', 'schema:opens': '14:00', 'schema:closes': '18:00' },
    ],
  });
  const hours = extractHours(r, TODAY);
  assert.equal(hours.length, 1);
  assert.equal(hours[0].days[0], 'mardi');
  assert.equal(hours[0].opens, '14:00');
});

test('un prix nul explicite peut être gratuit, un mélange gratuit/payant ne l’est pas', () => {
  const free = withDetails({ 'schema:offers': { 'schema:priceSpecification': { 'schema:minPrice': 0, 'schema:maxPrice': 0, 'schema:priceCurrency': 'EUR' } } });
  assert.equal(extractPrices(free, TODAY).free, true);

  const mixed = withDetails({ 'schema:offers': { 'schema:priceSpecification': [
    { 'schema:minPrice': 0, 'schema:maxPrice': 0 },
    { 'schema:minPrice': 6, 'schema:maxPrice': 6 },
  ] } });
  assert.equal(extractPrices(mixed, TODAY).free, null);

  const notFree = withDetails({ 'schema:isAccessibleForFree': false });
  assert.equal(extractPrices(notFree, TODAY).free, false);

  assert.deepEqual(extractPrices(record(), TODAY), { items: [], free: null, sourceRefs: [] });
});

test('les droits des médias sont contrôlés, sans afficher une affiche comme photo de lieu', () => {
  const media = (overrides) => ({ url: 'https://images.example.test/photo.jpg', credit: 'Photographe', rights_status: 'eligible_with_credit', rights_start: null, rights_end: null, source_ref: 'datatourisme:https://example.test/1', scope: 'place', ...overrides });
  const r = record({ media: [
    media({}),
    media({ credit: 'Non communiqué' }),
    media({ rights_end: '2020-01-01' }),
    media({ scope: 'event' }),
    media({ url: 'https://images.example.test/affiche.jpg' }),
  ] });
  const out = extractMedia(r, 'place', TODAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].credit, 'Photographe');
  assert.equal(out[0].source, 'DATAtourisme');
});

test('les observations contradictoires restent distinctes', () => {
  const r = record({
    accessibility_observations: [
      { source_ref: 'hilia:1', scope: 'place', values: { entree_plain_pied: 1 } },
      { source_ref: 'acceslibre:2', scope: 'place', values: { entree_plain_pied: false } },
    ],
    details_by_source: {
      'hilia:1': { details: {} },
      'acceslibre:2': { details: { reducedMobilityAccess: true } },
    },
    sources: [
      { source: 'hilia', source_id: '1', licence: 'existing_internal' },
      { source: 'acceslibre', source_id: '2', licence: 'etalab-2.0' },
    ],
  });
  const out = extractAccessibility(r);
  assert.equal(out.observations.length, 2);
  assert.equal(out.reducedMobility, true);
  assert.equal(out.sources.length, 2);
  assert.equal(out.observations[0].values.entree_plain_pied, 1);
  assert.equal(out.observations[1].values.entree_plain_pied, false);
});

test('les dates d’événement ne sont jamais déduites d’un pointeur data:', () => {
  assert.equal(extractEventDates(record({ schedule: { periods: 'data:abc' } })), null);
  assert.equal(extractEventDates(record({ schedule: { periods: { startDate: '2026-12-01', endDate: '2026-11-01' } } })), null);
  const dates = extractEventDates(record({ schedule: { periods: { startDate: '2026-12-01', endDate: '2026-12-02' } } }));
  assert.deepEqual(dates, { start: '2026-12-01', end: '2026-12-02', occurrence: true, note: '' });
});

test('les occurrences récurrentes utilisent la prochaine date, pas la plage de validité', () => {
  const dates = extractEventDates(record({
    schedule: {
      date_min: '2025-11-16',
      date_max: '2026-12-20',
      periods: [
        { startDate: '2025-11-16', endDate: '2025-11-16', startTime: '09:00:00' },
        { startDate: '2026-12-20', endDate: '2026-12-20', startTime: '10:00:00' },
        'data:pointer',
      ],
    },
  }), TODAY);
  assert.equal(dates.start, '2026-12-20');
  assert.equal(dates.end, '2026-12-20');
  assert.equal(dates.periodCount, undefined);
  assert.equal(dates.startTime, '10:00');
  assert.equal(dates.periods, undefined);
});

test('deux occurrences futures restent deux dates distinctes', () => {
  const dates = extractEventDates(record({
    schedule: { periods: [
      { startDate: '2026-12-20', endDate: '2026-12-20' },
      { startDate: '2027-01-17', endDate: '2027-01-17' },
    ] },
  }), TODAY);
  assert.equal(dates.start, '2026-12-20');
  assert.equal(dates.periodCount, 2);
  assert.equal(dates.periods.length, 2);
  assert.equal(dates.periods[1].start, '2027-01-17');
});

test('un événement review_dates ou expiré n’est pas publié', () => {
  const base = record({ kind: 'event', publication_status: 'review_dates', schedule: { date_min: '2026-12-01', date_max: '2026-12-02' } });
  assert.equal(buildEventDetail(base, TODAY), null);
  const expired = { ...base, publication_status: 'candidate_event', schedule: { date_min: '2020-01-01', date_max: '2020-01-02' } };
  assert.equal(buildEventDetail(expired, TODAY), null);
  const ok = { ...base, id: 'dt:event-ok', publication_status: 'candidate_event' };
  assert.equal(buildEventDetail(ok, TODAY).id, 'dt:event-ok');
});

test('un lieu existant inconnu du snapshot n’est pas enrichi', () => {
  const known = record({ existing_hilia_id: '1' });
  assert.equal(buildPlaceDetail(known, new Set(['1']), TODAY).id, '1');
  assert.equal(buildPlaceDetail(known, new Set(['2']), TODAY), null);
});

test('chaque catégorie du paquet a une famille explicite', async () => {
  const { readFile } = await import('node:fs/promises');
  const audit = JSON.parse(await readFile(new URL('../../../data/import-preview/audit-source.json', import.meta.url), 'utf8'));
  const unknown = Object.keys(audit.categories).filter((name) => familyOf(name) === 'Autres loisirs' && !['Loisirs', 'Prestataire de loisirs', 'Location de matériel de loisirs'].includes(name));
  assert.deepEqual(unknown, []);
});

test('le lecteur recolle les descriptions multi-lignes sans perdre le texte', async () => {
  const { writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = `${tmpdir()}/hilia-jsonl-${process.pid}.jsonl`;
  await writeFile(path, [
    '{"kind":"manifest","schema_version":"1.0"}',
    '{"id":"hilia:1","kind":"place","name":"A","description":"ligne 1',
    'ligne 2"}',
    '{"id":"hilia:2","kind":"place","name":"B","description":null}',
    '',
  ].join('\n'));
  try {
    const { scanHiliaJsonl } = await import('../lib/read-jsonl.mjs');
    const result = await scanHiliaJsonl(path);
    assert.equal(result.records, 3);
    assert.equal(result.samples.place.description, 'ligne 1\nligne 2');
  } finally {
    await unlink(path);
  }
});

test('le prix d’un événement reste déclaratif, sans disponibilité inventée', () => {
  const r = withDetails({ 'schema:offers': { 'schema:priceSpecification': { 'schema:minPrice': 8, 'schema:maxPrice': 10, 'schema:priceCurrency': 'EUR' } } }, { kind: 'event', publication_status: 'candidate_event', schedule: { date_min: '2026-12-01', date_max: '2026-12-02' } });
  const detail = buildEventDetail(r, TODAY);
  assert.equal(detail.prices.items[0].min, 8);
  assert.equal(detail.booking, undefined);
  assert.equal(detail.prices.free, null);
});
