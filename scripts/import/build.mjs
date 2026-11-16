#!/usr/bin/env node
/**
 * Construit les données publiques à partir du paquet, sans écrire dans Supabase.
 *
 *   node scripts/import/build.mjs --dry-run   # simulation + rapport seulement
 *   node scripts/import/build.mjs             # écrit data/place-details, events...
 *
 * Seules les fiches existantes (existing_preserved) sont enrichies dans le
 * catalogue public actuel. Les nouveaux lieux, activités et itinéraires restent
 * des candidats de staging : ils ne sont pas publiés par ce script.
 * Les événements ne sont publiés que si leur statut est candidate_event, que
 * leurs dates sont explicites et qu'ils ne sont pas terminés. review_dates est
 * exclu jusqu'à vérification humaine.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readHiliaJsonl } from './lib/read-jsonl.mjs';
import { bucketName, bucketOf } from './lib/buckets.mjs';
import { familyOf } from './lib/categories.mjs';
import { EXCLUDED_PLACE_IDS } from '../../lib/place-exclusions.js';
import {
  buildEventDetail,
  buildPlaceDetail,
  eventIndexEntry,
  reviewStatusOf,
  todayIso,
} from './lib/normalize.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SOURCE = arg('--source', process.env.HILIA_SOURCE || 'D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl');
const DRY = args.includes('--dry-run');
const ROOT = new URL('../../', import.meta.url);
const TODAY = todayIso();
const PLACE_BUCKETS = 256;
const EVENT_BUCKETS = 128;

const snapshot = JSON.parse(await readFile(new URL('data/places.json', ROOT), 'utf8'));
const snapshotIds = new Set(snapshot.rows.map((row) => String(row[0])));
const placeShards = Array.from({ length: PLACE_BUCKETS }, () => ({}));
const eventShards = Array.from({ length: EVENT_BUCKETS }, () => ({}));
const events = [];
const categories = new Map();
const mediaHosts = new Set();
const stats = {
  generatedAt: new Date().toISOString(),
  source: path.basename(SOURCE),
  dryRun: DRY,
  today: TODAY,
  records: 0,
  kinds: {},
  existingPlaces: 0,
  existingMatched: 0,
  qualityExcluded: 0,
  placeDetails: 0,
  placeDetailsWithDescription: 0,
  placeDetailsWithMedia: 0,
  placeDetailsWithHours: 0,
  placeDetailsWithPrices: 0,
  placeDetailsWithContacts: 0,
  newPlacesStaged: 0,
  duplicateCandidates: 0,
  activitiesStaged: 0,
  routesStaged: 0,
  events: 0,
  eventsPublished: 0,
  eventsWithoutDates: 0,
  eventsReviewDates: 0,
  eventsExpired: 0,
  eventsWithMedia: 0,
  eventsWithPrices: 0,
  eventsWithBooking: 0,
  eventsLongRangeExcluded: 0,
  eventsTooFarExcluded: 0,
  categories: 0,
  mediaItems: 0,
  mediaHosts: 0,
  bytes: 0,
  excluded: {},
  warnings: [],
};
const inc = (key) => { stats.kinds[key] = (stats.kinds[key] || 0) + 1; };
const exclude = (reason) => { stats.excluded[reason] = (stats.excluded[reason] || 0) + 1; };

for await (const { record } of readHiliaJsonl(SOURCE)) {
  stats.records += 1;
  const kind = record.kind || 'unknown';
  inc(kind);
  if (kind === 'manifest') continue;
  for (const category of record.categories || []) {
    const name = String(category || '').trim();
    if (name) categories.set(name, (categories.get(name) || 0) + 1);
  }
  const reviewStatus = reviewStatusOf(record);
  if (reviewStatus === 'duplicate_review') stats.duplicateCandidates += 1;

  if (kind === 'place') {
    if (record.existing_hilia_id && EXCLUDED_PLACE_IDS.has(String(record.existing_hilia_id))) {
      stats.qualityExcluded += 1;
      exclude('quality_exclusion');
      continue;
    }
    if (record.existing_hilia_id) {
      stats.existingPlaces += 1;
      if (!snapshotIds.has(String(record.existing_hilia_id))) {
        exclude('existing_id_absent_from_snapshot');
        stats.warnings.push(`ID existant absent du snapshot : ${record.existing_hilia_id}`);
        continue;
      }
      stats.existingMatched += 1;
      const detail = buildPlaceDetail(record, snapshotIds, TODAY);
      if (detail) {
        const bucket = bucketOf(detail.id, PLACE_BUCKETS);
        placeShards[bucket][detail.id] = detail;
        stats.placeDetails += 1;
        if (detail.description) stats.placeDetailsWithDescription += 1;
        if (detail.media) { stats.placeDetailsWithMedia += 1; stats.mediaItems += detail.media.length; }
        if (detail.hours) stats.placeDetailsWithHours += 1;
        if (detail.prices) stats.placeDetailsWithPrices += 1;
        if (detail.contacts) stats.placeDetailsWithContacts += 1;
        for (const media of detail.media || []) addHost(media.url);
      }
    } else {
      stats.newPlacesStaged += 1;
    }
  } else if (kind === 'event') {
    stats.events += 1;
    if (record.publication_status === 'review_dates') {
      stats.eventsReviewDates += 1;
      exclude('event_dates_review');
      continue;
    }
    const detail = buildEventDetail(record, TODAY);
    if (!detail) {
      if (!record.schedule?.date_min && !record.schedule?.periods?.startDate) stats.eventsWithoutDates += 1;
      else stats.eventsExpired += 1;
      exclude('event_no_explicit_date_or_expired');
      continue;
    }
    const spanDays = (Date.parse(detail.dates.end) - Date.parse(detail.dates.start)) / 86400000;
    const horizon = Date.parse(TODAY) + 5 * 365.25 * 86400000;
    if (spanDays > 90) {
      // Une période de plusieurs mois est le plus souvent un lieu, une activité
      // récurrente ou une donnée de validité, pas une date de sortie.
      stats.eventsLongRangeExcluded += 1;
      exclude('event_occurrence_over_90_days');
      continue;
    }
    if (Date.parse(detail.dates.start) > horizon) { stats.eventsTooFarExcluded += 1; exclude('event_starts_after_5_years'); continue; }
    const bucket = bucketOf(detail.id, EVENT_BUCKETS);
    eventShards[bucket][detail.id] = detail;
    events.push(eventIndexEntry(detail));
    stats.eventsPublished += 1;
    if (detail.media) { stats.eventsWithMedia += 1; stats.mediaItems += detail.media.length; }
    if (detail.prices) stats.eventsWithPrices += 1;
    if (detail.booking) stats.eventsWithBooking += 1;
    for (const media of detail.media || []) addHost(media.url);
  } else if (kind === 'activity') {
    stats.activitiesStaged += 1;
  } else if (kind === 'route') {
    stats.routesStaged += 1;
  } else if (kind === 'category') {
    // La liste des catégories est reconstruite depuis les fiches.
  } else if (kind !== 'manifest') {
    exclude(`unknown_kind_${kind}`);
  }
}

function addHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') mediaHosts.add(u.hostname.toLowerCase());
  } catch { /* URL déjà validée à l'extraction */ }
}

events.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name, 'fr'));
stats.categories = categories.size;
stats.mediaHosts = mediaHosts.size;
const categoryList = [...categories.keys()].sort((a, b) => a.localeCompare(b, 'fr'));
const familyCounts = {};
for (const category of categoryList) {
  const family = familyOf(category);
  familyCounts[family] = (familyCounts[family] || 0) + (categories.get(category) || 0);
}
const generatedAt = stats.generatedAt;

if (DRY) {
  await mkdir(new URL('data/import-preview', ROOT), { recursive: true });
  await writeFile(new URL('data/import-preview/simulation.json', ROOT), JSON.stringify({ ...stats, categories: categoryList, familyCounts }, null, 2));
  console.log(JSON.stringify({ ...stats, categories: categoryList.length, familyCounts }, null, 2));
  console.error('Simulation terminée : aucune donnée publique ni Supabase modifiée.');
  process.exit(0);
}

// ---------- Écriture des shards de fiches ----------
const placeDir = new URL('data/place-details/', ROOT);
await rm(placeDir, { recursive: true, force: true });
await mkdir(placeDir, { recursive: true });
for (let i = 0; i < PLACE_BUCKETS; i += 1) {
  const places = placeShards[i];
  if (!Object.keys(places).length) continue;
  const file = new URL(`${bucketName(i)}.json`, placeDir);
  const body = JSON.stringify({ v: 1, bucket: i, generatedAt, places });
  await writeFile(file, body);
  stats.bytes += Buffer.byteLength(body);
}

// ---------- Événements ----------
const eventDir = new URL('data/event-details/', ROOT);
await rm(eventDir, { recursive: true, force: true });
await mkdir(eventDir, { recursive: true });
for (let i = 0; i < EVENT_BUCKETS; i += 1) {
  const records = eventShards[i];
  if (!Object.keys(records).length) continue;
  const file = new URL(`${bucketName(i)}.json`, eventDir);
  const body = JSON.stringify({ v: 1, bucket: i, generatedAt, events: records });
  await writeFile(file, body);
  stats.bytes += Buffer.byteLength(body);
}
const eventIndex = {
  v: 1,
  generatedAt,
  source: path.basename(SOURCE),
  note: 'Événements DATAtourisme et Que faire à Paris avec dates explicites. Accessibilité déclarée, non vérifiée par HILIA.',
  count: events.length,
  categories: categoryList,
  families: familyCounts,
  events,
};
const eventBody = JSON.stringify(eventIndex);
await writeFile(new URL('data/events.json', ROOT), eventBody);
stats.bytes += Buffer.byteLength(eventBody);

// ---------- Allowlist du proxy d'images ----------
const hostFile = new URL('lib/media-hosts.js', ROOT);
const hosts = [...mediaHosts].sort();
await writeFile(hostFile, `/* Généré par scripts/import/build.mjs. Ne pas éditer à la main. */\nexport const MEDIA_HOSTS = new Set(${JSON.stringify(hosts, null, 2)});\n`);

// ---------- Rapport ----------
await mkdir(new URL('data/import-preview', ROOT), { recursive: true });
await writeFile(new URL('data/import-preview/build-report.json', ROOT), JSON.stringify({
  ...stats,
  output: {
    placeDetails: 'data/place-details/',
    events: 'data/events.json',
    eventDetails: 'data/event-details/',
    mediaHosts: 'lib/media-hosts.js',
  },
  familyCounts,
  categories: categoryList,
}, null, 2));

const mo = (n) => `${(n / 1048576).toFixed(2)} Mo`;
console.log(JSON.stringify({
  records: stats.records,
  existingMatched: stats.existingMatched,
  placeDetails: stats.placeDetails,
  eventsPublished: stats.eventsPublished,
  eventsReviewDates: stats.eventsReviewDates,
  activitiesStaged: stats.activitiesStaged,
  routesStaged: stats.routesStaged,
  newPlacesStaged: stats.newPlacesStaged,
  duplicateCandidates: stats.duplicateCandidates,
  mediaItems: stats.mediaItems,
  mediaHosts: stats.mediaHosts,
  output: mo(stats.bytes),
  familyCounts,
}, null, 2));
console.error(`Données publiques écrites. Rapport : data/import-preview/build-report.json (${mo(stats.bytes)}).`);
