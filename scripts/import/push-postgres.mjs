#!/usr/bin/env node
/**
 * Import PostgreSQL direct, par lots, avec reprise et rollback.
 *
 * La clé service_role de production n'est pas disponible localement : ce
 * chemin utilise uniquement la connexion d'administration HILIA_PROD_DB_URL et
 * les fonctions SQL déjà déployées.
 *
 *   npm run import:push-postgres -- --source <jsonl>
 *   HILIA_IMPORT_DB_URL=... npm run import:push-postgres -- --source <jsonl> --execute
 *   npm run import:push-postgres -- --run-id <uuid> --execute --resume
 *   npm run import:push-postgres -- --rollback <uuid> --execute
 *
 * Pour le projet de test uniquement :
 *   HILIA_IMPORT_DB_URL="$HILIA_TEST_DB_URL" HILIA_IMPORT_ALLOW_TEST=1 npm run import:push-postgres -- --execute
 *
 * Sans --execute, aucune connexion ni écriture n'est faite.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { readHiliaJsonl } from './lib/read-jsonl.mjs';
import {
  buildPlaceDetail,
  buildStagedPlaceDetail,
  extractContacts,
  reviewStatusOf,
} from './lib/normalize.mjs';
import { assessCandidate } from './lib/publication.mjs';
import { EXCLUDED_PLACE_IDS } from '../../lib/place-exclusions.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
const SOURCE = arg('--source', process.env.HILIA_SOURCE || 'D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl');
const EXECUTE = has('--execute');
const RESUME = has('--resume');
const RUN_ID = arg('--run-id', null);
const ROLLBACK = arg('--rollback', null);
const LIMIT = Number(arg('--limit', '0')) || 0;
const MAX_BATCHES = Number(arg('--max-batches', '0')) || 0;
const BATCH = Math.max(1, Math.min(500, Number(arg('--batch', '200')) || 200));
const DATABASE_URL = process.env.HILIA_IMPORT_DB_URL || process.env.HILIA_PROD_DB_URL || '';
const ALLOW_TEST = process.env.HILIA_IMPORT_ALLOW_TEST === '1';
const TEST_REF = String(process.env.HILIA_TEST_PROJECT_REF || '').trim();
const TODAY = new Date().toISOString().slice(0, 10);

const SNAPSHOT = JSON.parse(await readFile(new URL('../../data/places.json', import.meta.url), 'utf8'));
const snapshotIds = new Set(SNAPSHOT.rows.map((row) => String(row[0])));

const APPROVAL_ACCESS_FIELDS = {
  transport_station_presence: 8,
  stationnement_presence: 9,
  stationnement_pmr: 10,
  stationnement_ext_presence: 11,
  stationnement_ext_pmr: 12,
  entree_reperage: 20,
  entree_plain_pied: 21,
  entree_ascenseur: 22,
  entree_marches: 23,
  entree_rampe: 24,
  entree_dispositif_appel: 25,
  entree_balise_sonore: 26,
  entree_aide_humaine: 27,
  entree_largeur_mini: 28,
  entree_pmr: 29,
  accueil_audiodescription_presence: 31,
  accueil_equipements_malentendants_presence: 32,
  accueil_cheminement_plain_pied: 33,
  accueil_signaletique: 34,
  sanitaires_presence: 35,
  sanitaires_pmr: 36,
};

function accessValue(key, value) {
  if (key === 'entree_marches' || key === 'entree_largeur_mini') {
    return typeof value !== 'boolean' && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  if (value === true || value === 1 || value === '1' || value === 'True') return 1;
  if (value === false || value === 0 || value === '0' || value === 'False') return 0;
  return null;
}

function accessForApproval(record) {
  const access = {};
  const conflicts = new Set();
  let known = 0;
  for (const observation of record.accessibility_observations || []) {
    const values = observation && observation.values && typeof observation.values === 'object' ? observation.values : {};
    for (const [key, field] of Object.entries(APPROVAL_ACCESS_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(values, key) || conflicts.has(field)) continue;
      const value = accessValue(key, values[key]);
      if (value == null) continue;
      if (Object.prototype.hasOwnProperty.call(access, field)) {
        if (access[field] !== value) { delete access[field]; known -= 1; conflicts.add(field); }
        continue;
      }
      access[field] = value;
      known += 1;
    }
  }
  access._unknown = known === 0;
  return access;
}

function approvalOf(record, detail) {
  const contacts = (detail && detail.contacts) || extractContacts(record);
  const categories = (record.categories || []).filter((name) => typeof name === 'string' && name.trim());
  const latitudeValue = record.coordinates?.latitude;
  const longitudeValue = record.coordinates?.longitude;
  const latitude = latitudeValue == null || latitudeValue === '' ? NaN : Number(latitudeValue);
  const longitude = longitudeValue == null || longitudeValue === '' ? NaN : Number(longitudeValue);
  return {
    name: record.name || null,
    activity: categories.length ? categories[0].trim() : null,
    address: record.address || null,
    postal_code: record.postal_code || null,
    commune: record.commune || null,
    site: contacts.websites?.[0] || null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    access: accessForApproval(record),
    ...(detail ? { detail } : {}),
  };
}

function rowOf(record) {
  const first = record.sources?.[0];
  const review = assessCandidate(record, TODAY);
  const sourceId = record.existing_hilia_id ? String(record.existing_hilia_id) : String(record.id || '').replace(/^[^:]+:/, '');
  const qualityExcluded = EXCLUDED_PLACE_IDS.has(sourceId);
  return {
    id: String(record.id),
    kind: record.kind,
    source: first?.source || String(record.id).split(':')[0],
    source_id: first?.source_id || String(record.id).slice(String(record.id).indexOf(':') + 1),
    existing_hilia_id: record.existing_hilia_id ? String(record.existing_hilia_id) : null,
    name: record.name || null,
    commune: record.commune || null,
    postal_code: record.postal_code || null,
    publication_status: record.publication_status || null,
    review_status: qualityExcluded ? 'quality_review' : reviewStatusOf(record),
    auto_publishable: qualityExcluded ? false : review.autoPublishable,
    review_level: qualityExcluded ? 'manual' : review.reviewLevel,
    review_reasons: qualityExcluded ? ['quality_exclusion', 'source_identity_incoherent'] : review.reasons,
    payload: record,
  };
}

function licencePartition(record) {
  return [...new Set((record.sources || []).map((s) => s.source === 'paris_events' ? 'paris_odbl' : s.licence).filter(Boolean))];
}

function publishedPlaceId(recordId) {
  return 'place_imp_' + createHash('md5').update(String(recordId)).digest('hex').slice(0, 20);
}

function validateTarget() {
  if (!DATABASE_URL) throw new Error('HILIA_IMPORT_DB_URL ou HILIA_PROD_DB_URL absent');
  let u;
  try { u = new URL(DATABASE_URL); } catch { throw new Error('URL de connexion invalide'); }
  const prod = u.hostname === 'aws-0-eu-west-1.pooler.supabase.com' && u.username.includes('lokplzdkvzilsuuqflsk');
  const test = ALLOW_TEST && u.hostname === 'aws-1-eu-central-1.pooler.supabase.com' && TEST_REF && u.username.includes(TEST_REF);
  if (!prod && !test) throw new Error('cible refusée : la connexion ne pointe pas vers la production HILIA ou, avec HILIA_IMPORT_ALLOW_TEST=1, vers le projet de test déclaré');
  return prod ? 'production' : 'test';
}

function makeDetail(record) {
  const placeId = record.existing_hilia_id ? String(record.existing_hilia_id) : publishedPlaceId(record.id);
  const detail = record.existing_hilia_id
    ? buildPlaceDetail(record, snapshotIds, TODAY)
    : buildStagedPlaceDetail(record, placeId, TODAY);
  return {
    detail,
    json: detail ? {
      place_id: detail.id,
      description: detail.description || null,
      description_source: detail.descriptionSource || null,
      categories: detail.categories || [],
      media: detail.media || [],
      hours: detail.hours || [],
      prices: detail.prices || null,
      contacts: detail.contacts || null,
      accessibility: detail.accessibility || null,
      source_refs: detail.sourceRefs || [],
      licence_partition: licencePartition(record),
      is_public: false,
    } : null,
  };
}

async function loadManifest() {
  for await (const { record } of readHiliaJsonl(SOURCE)) {
    if (record.kind === 'manifest') return record;
  }
  throw new Error('manifest absent du fichier source');
}

function sourceSha(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

async function getRun(client, id) {
  const result = await client.query('select * from public.hilia_import_runs where id = $1', [id]);
  return result.rows[0] || null;
}

async function createRun(client, manifest) {
  const id = randomUUID();
  await client.query(
    `insert into public.hilia_import_runs
       (id, source_name, source_sha256, schema_version, manifest, status, cursor, counts)
     values ($1, $2, $3, $4, $5::jsonb, 'running', 0, '{}'::jsonb)`,
    [id, path.basename(SOURCE), sourceSha(manifest), manifest.schema_version || null, JSON.stringify(manifest)],
  );
  return id;
}

async function patchRun(client, id, patch) {
  await client.query(
    `update public.hilia_import_runs
     set status = coalesce($2, status), cursor = coalesce($3, cursor),
         counts = coalesce($4::jsonb, counts), finished_at = case when $2 = 'completed' then coalesce($5, now()) else finished_at end,
         updated_at = now()
     where id = $1`,
    [id, patch.status || null, patch.cursor ?? null, patch.counts ? JSON.stringify(patch.counts) : null, patch.finished_at || null],
  );
}

async function flushBatch(client, runId, batchNo, rows, details, meta, cursor, counts) {
  const checksum = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const started = new Date().toISOString();
  await client.query('begin');
  try {
    const staged = await client.query('select public.hilia_import_upsert($1, $2::jsonb) as result', [runId, JSON.stringify(rows)]);
    const applied = await client.query('select public.hilia_upsert_place_details($1, $2::jsonb) as result', [runId, JSON.stringify(details)]);
    const inserted = Number(staged.rows[0]?.result?.inserted) || 0;
    const updated = Number(staged.rows[0]?.result?.updated) || 0;
    const affected = Number(applied.rows[0]?.result?.affected) || 0;
    await client.query(
      `insert into public.hilia_import_batches
         (run_id, batch_no, checksum, record_count, inserted_count, updated_count, status, started_at, finished_at)
       values ($1, $2, $3, $4, $5, $6, 'completed', $7, now())
       on conflict (run_id, batch_no) do update set
         checksum = excluded.checksum, record_count = excluded.record_count,
         inserted_count = excluded.inserted_count, updated_count = excluded.updated_count,
         status = excluded.status, finished_at = excluded.finished_at`,
      [runId, batchNo, checksum, rows.length, inserted, updated, started],
    );
    const next = {
      records: (counts.records || 0) + rows.length,
      staged: (counts.staged || 0) + rows.length,
      details: (counts.details || 0) + affected,
      batches: batchNo,
    };
    await patchRun(client, runId, { cursor, counts: next });
    await client.query('commit');
    return { inserted, updated, affected, counts: next };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

if (ROLLBACK) {
  if (!EXECUTE) { console.log(JSON.stringify({ mode: 'plan', action: 'rollback', runId: ROLLBACK }, null, 2)); process.exit(0); }
  const target = validateTarget();
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    const result = await client.query('select public.hilia_import_rollback($1) as result', [ROLLBACK]);
    console.log(JSON.stringify({ mode: 'rollback', target, result: result.rows[0]?.result }, null, 2));
  } finally { await client.end().catch(() => {}); }
  process.exit(0);
}

const manifest = await loadManifest();
let runId = RUN_ID;
let cursor = 0;
let batchNo = 0;
let counts = { records: 0, staged: 0, details: 0, batches: 0 };
let client;
try {
  if (!EXECUTE) {
    const summary = { mode: 'plan', target: DATABASE_URL ? 'configured' : 'absent', source: path.basename(SOURCE), manifest: manifest.schema_version || null, batch: BATCH, limit: LIMIT || null, max_batches: MAX_BATCHES || null };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }
  const target = validateTarget();
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  if (RESUME) {
    if (!runId) throw new Error('--resume exige --run-id');
    const run = await getRun(client, runId);
    if (!run) throw new Error(`Run introuvable : ${runId}`);
    if (run.status === 'completed') { console.log(JSON.stringify({ mode: 'resume', runId, note: 'déjà terminé' }, null, 2)); process.exit(0); }
    cursor = Number(run.cursor) || 0;
    counts = { records: 0, staged: 0, details: 0, batches: 0, ...(run.counts || {}) };
    const last = await client.query('select coalesce(max(batch_no), 0)::int as n from public.hilia_import_batches where run_id = $1', [runId]);
    batchNo = last.rows[0]?.n || 0;
    console.log(JSON.stringify({ mode: 'resume', runId, cursor, batchNo, target }, null, 2));
  } else {
    runId = await createRun(client, manifest);
    console.log(JSON.stringify({ mode: 'execute', runId, target, source: path.basename(SOURCE) }, null, 2));
  }

  let sourceIndex = 0;
  let selected = 0;
  let staging = [];
  let details = [];
  let meta = [];
  let stopped = false;
  let completed = false;

  async function flush() {
    if (!staging.length) return;
    const lastIndex = Math.max(...meta);
    const result = await flushBatch(client, runId, ++batchNo, staging, details, meta, lastIndex, counts);
    counts = result.counts;
    cursor = lastIndex;
    staging = [];
    details = [];
    meta = [];
    if (MAX_BATCHES && batchNo >= MAX_BATCHES) stopped = true;
  }

  for await (const { record } of readHiliaJsonl(SOURCE)) {
    sourceIndex += 1;
    if (sourceIndex <= cursor) continue;
    if (!record || !['place', 'event', 'activity', 'route'].includes(record.kind)) continue;
    selected += 1;
    const row = rowOf(record);
    if (record.kind === 'place') {
      const made = makeDetail(record);
      if (!record.existing_hilia_id) row.approval = approvalOf(record, made.detail);
      if (made.json) details.push(made.json);
    }
    staging.push(row);
    meta.push(sourceIndex);
    if (staging.length >= BATCH) {
      await flush();
      if (stopped) break;
    }
    if (LIMIT && selected >= LIMIT) { stopped = true; break; }
  }
  if (!stopped) {
    await flush();
    completed = true;
    await patchRun(client, runId, { status: 'completed', cursor: sourceIndex, counts, finished_at: new Date().toISOString() });
    cursor = sourceIndex;
  } else if (staging.length) {
    await flush();
  }
  console.log(JSON.stringify({ mode: EXECUTE ? 'execute' : 'plan', runId, target, completed, stopped, cursor, counts }, null, 2));
} catch (error) {
  if (client) {
    await client.query('rollback').catch(() => {});
    if (runId) await patchRun(client, runId, { status: 'failed', cursor, counts }).catch(() => {});
  }
  console.error('Import PostgreSQL interrompu :', String(error?.message || error).slice(0, 800));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
