#!/usr/bin/env node
/**
 * Analyse le fichier source sans rien écrire dans Supabase.
 *
 * Usage :
 *   node scripts/import/analyze.mjs [--source <HILIA_DONNEES.jsonl>] [--out <rapport.json>]
 *
 * Le fichier source reste hors du dépôt : son chemin est passé en argument ou
 * défini par HILIA_SOURCE. Le rapport, lui, est versionnable : il contient des
 * compteurs, pas les 843 Mo de données.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { scanHiliaJsonl } from './lib/read-jsonl.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SOURCE = arg('--source', process.env.HILIA_SOURCE || 'D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl');
const OUT = arg('--out', 'data/import-preview/audit-source.json');
const SNAPSHOT = new URL('../../data/places.json', import.meta.url);

const counts = (key) => Object.create(null);
const inc = (obj, key, n = 1) => { obj[key || '(absent)'] = (obj[key || '(absent)'] || 0) + n; };
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const pushLimited = (arr, value, max = 20) => { if (arr.length < max) arr.push(value); };

const stats = {
  generatedAt: new Date().toISOString(),
  source: path.basename(SOURCE),
  records: 0,
  repairedRecords: 0,
  counts: {},
  publicationStatus: counts(),
  kinds: counts(),
  sources: counts(),
  licences: counts(),
  categories: {},
  descriptions: { total: 0, empty: 0, chars: 0, max: 0, withSource: 0 },
  media: { records: 0, items: 0, eligibleWithCredit: 0, rightsStatus: counts(), scope: counts(), http: 0, https: 0 },
  practical: {
    anyContact: 0, email: 0, phone: 0, website: 0,
    anyHours: 0, anyPrice: 0,
    contactByKind: counts(), hoursByKind: counts(), priceByKind: counts(),
  },
  accessibility: { records: 0, observations: 0, scopes: counts(), withHilia: 0, withAcceslibre: 0 },
  events: { records: 0, withDates: 0, withoutDates: 0, past: 0, current: 0, future: 0, invalidRange: 0, reviewDates: 0, examples: [] },
  identity: { ids: 0, duplicateIds: 0, duplicateExamples: [], existingHiliaId: 0, existingSnapshotMatched: 0, existingSnapshotMissing: 0, missingExamples: [], existingSnapshotNameDiff: 0, existingSnapshotNameDiffExamples: [] },
  duplicates: { candidatesRecords: 0, candidates: 0, examples: [] },
  keys: { details: {}, sourceDetails: {} },
  manifest: null,
  samples: {},
  warnings: [],
};

const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
const snapshotNames = new Map(snapshot.rows.map((r) => [String(r[0]), r[1]]));
const snapshotIds = new Set(snapshotNames.keys());
const seenIds = new Map();
const seenCategories = new Map();
const detailKeys = new Map();
const sourceDetailKeys = new Map();
const today = '2026-11-13';

function visitKeys(obj, map, depth = 0, prefix = '') {
  if (!obj || typeof obj !== 'object' || depth > 4) return;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    bump(map, p);
    if (v && typeof v === 'object') visitKeys(v, map, depth + 1, p);
  }
}

function walk(value, visit, depth = 0) {
  if (value == null || depth > 8) return;
  if (Array.isArray(value)) { for (const v of value) walk(v, visit, depth + 1); return; }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    visit(k, v);
    if (v && typeof v === 'object') walk(v, visit, depth + 1);
  }
}

function practicalOf(record) {
  let email = false, phone = false, website = false, hours = false, price = false;
  walk(record.details_by_source, (k, v) => {
    const key = k.toLowerCase();
    if (typeof v === 'string' && v.trim()) {
      if (/email|mail/.test(key)) email = true;
      if (/telephone|phone|tel\b/.test(key)) phone = true;
      if (/homepage|site_internet|website|url/.test(key) && /^https?:/i.test(v)) website = true;
    }
    if (/openinghours|horaire|opening_hours/.test(key)) hours = true;
    if (/price|tarif|offers/.test(key) && v != null) price = true;
  });
  if (hours) {
    // Un simple lien vers une fiche "data:" ne prouve pas que les horaires
    // soient lisibles. On ne compte que les valeurs explicites.
    hours = false;
    walk(record.details_by_source, (k, v) => {
      if (!/openinghours|horaire|opening_hours/i.test(k)) return;
      if (typeof v === 'string' && v.startsWith('data:')) return;
      if (v != null) hours = true;
    });
  }
  return { email, phone, website, hours, price };
}

const scan = await scanHiliaJsonl(SOURCE, async (record) => {
  stats.records += 1;
  const kind = record.kind || 'unknown';
  inc(stats.kinds, kind);
  inc(stats.publicationStatus, record.publication_status || '(none)');
  if (record.publication_status === 'review_dates' && kind === 'event') stats.events.reviewDates += 1;

  if (kind === 'manifest') { stats.manifest = record; return; }
  if (!record.id && kind !== 'category') stats.warnings.push(`Enregistrement ${kind} sans id.`);
  if (record.id) {
    const prev = seenIds.get(record.id);
    if (prev) {
      stats.identity.duplicateIds += 1;
      pushLimited(stats.identity.duplicateExamples, { id: record.id, first: prev, next: kind });
    } else seenIds.set(record.id, kind);
  }
  stats.identity.ids = seenIds.size;

  if (record.existing_hilia_id) {
    stats.identity.existingHiliaId += 1;
    if (snapshotIds.has(String(record.existing_hilia_id))) {
      stats.identity.existingSnapshotMatched += 1;
      const expected = snapshotNames.get(String(record.existing_hilia_id));
      if (expected && record.name && String(expected) !== String(record.name)) {
        stats.identity.existingSnapshotNameDiff += 1;
        pushLimited(stats.identity.existingSnapshotNameDiffExamples, { id: record.existing_hilia_id, snapshot: expected, source: record.name });
      }
    } else {
      stats.identity.existingSnapshotMissing += 1;
      pushLimited(stats.identity.missingExamples, { id: record.existing_hilia_id, name: record.name });
    }
  }

  if (Array.isArray(record.match_candidates) && record.match_candidates.length) {
    stats.duplicates.candidatesRecords += 1;
    stats.duplicates.candidates += record.match_candidates.length;
    pushLimited(stats.duplicates.examples, { id: record.id, name: record.name, candidates: record.match_candidates.slice(0, 3) });
  }

  for (const source of record.sources || []) {
    inc(stats.sources, source.source);
    inc(stats.licences, source.licence);
  }

  for (const category of record.categories || []) {
    bump(seenCategories, category);
    stats.categories[category] = (stats.categories[category] || 0) + 1;
  }

  if (record.description) {
    stats.descriptions.total += 1;
    stats.descriptions.chars += record.description.length;
    stats.descriptions.max = Math.max(stats.descriptions.max, record.description.length);
    if (record.description_source) stats.descriptions.withSource += 1;
  } else if (kind !== 'category') stats.descriptions.empty += 1;

  if (Array.isArray(record.media) && record.media.length) {
    stats.media.records += 1;
    for (const media of record.media) {
      stats.media.items += 1;
      inc(stats.media.rightsStatus, media.rights_status);
      inc(stats.media.scope, media.scope);
      if (media.rights_status === 'eligible_with_credit' && media.credit) stats.media.eligibleWithCredit += 1;
      if (/^http:/i.test(media.url || '')) stats.media.http += 1;
      if (/^https:/i.test(media.url || '')) stats.media.https += 1;
    }
  }

  if (kind !== 'category') {
    const p = practicalOf(record);
    if (p.email || p.phone || p.website) stats.practical.anyContact += 1;
    if (p.email) { stats.practical.email += 1; inc(stats.practical.contactByKind, kind); }
    if (p.phone) stats.practical.phone += 1;
    if (p.website) stats.practical.website += 1;
    if (p.hours) { stats.practical.anyHours += 1; inc(stats.practical.hoursByKind, kind); }
    if (p.price) { stats.practical.anyPrice += 1; inc(stats.practical.priceByKind, kind); }
    if (record.details_by_source) {
      for (const [sourceRef, details] of Object.entries(record.details_by_source)) {
        visitKeys(details, detailKeys);
        const nested = details?.details;
        if (nested && typeof nested === 'object') visitKeys(nested, sourceDetailKeys);
        // Une observation d'accessibilité est déclarative : on ne la transforme
        // jamais en "accessible" par défaut.
        if (sourceRef.startsWith('hilia:')) stats.accessibility.withHilia += 1;
        if (sourceRef.startsWith('acceslibre:')) stats.accessibility.withAcceslibre += 1;
      }
    }
  }

  if (Array.isArray(record.accessibility_observations) && record.accessibility_observations.length) {
    stats.accessibility.records += 1;
    stats.accessibility.observations += record.accessibility_observations.length;
    for (const obs of record.accessibility_observations) inc(stats.accessibility.scopes, obs.scope);
  }

  if (kind === 'event') {
    stats.events.records += 1;
    const min = record.schedule?.date_min || record.schedule?.periods?.startDate || null;
    const max = record.schedule?.date_max || record.schedule?.periods?.endDate || null;
    if (min || max) {
      stats.events.withDates += 1;
      if (min && max && min > max) stats.events.invalidRange += 1;
      else if (max && max < today) stats.events.past += 1;
      else if (min && min > today) stats.events.future += 1;
      else stats.events.current += 1;
      pushLimited(stats.events.examples, { id: record.id, name: record.name, min, max, status: record.publication_status });
    } else stats.events.withoutDates += 1;
  }

  if (!stats.samples[kind]) stats.samples[kind] = record;
});

stats.counts = stats.kinds;
stats.categories = Object.fromEntries([...seenCategories].sort((a, b) => b[1] - a[1]));
stats.identity.existingSnapshotTotal = snapshotIds.size;
stats.keys.details = Object.fromEntries([...detailKeys].sort((a, b) => b[1] - a[1]).slice(0, 160));
stats.keys.sourceDetails = Object.fromEntries([...sourceDetailKeys].sort((a, b) => b[1] - a[1]).slice(0, 160));

const report = { ...stats, repairedRecords: scan.repaired };
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2));
const short = {
  records: stats.records,
  kinds: stats.kinds,
  publicationStatus: stats.publicationStatus,
  descriptions: stats.descriptions,
  media: { records: stats.media.records, items: stats.media.items, eligibleWithCredit: stats.media.eligibleWithCredit, rightsStatus: stats.media.rightsStatus },
  practical: stats.practical,
  accessibility: stats.accessibility,
  events: { ...stats.events, examples: stats.events.examples.slice(0, 3) },
  identity: { ...stats.identity, duplicateExamples: stats.identity.duplicateExamples.slice(0, 5), existingSnapshotNameDiffExamples: stats.identity.existingSnapshotNameDiffExamples.slice(0, 3) },
  duplicates: { ...stats.duplicates, examples: stats.duplicates.examples.slice(0, 3) },
  categories: Object.keys(stats.categories).length,
  sources: stats.sources,
  licences: stats.licences,
  keys: stats.keys,
};
console.log(JSON.stringify(short, null, 2));
console.error(`Rapport écrit dans ${OUT}`);
