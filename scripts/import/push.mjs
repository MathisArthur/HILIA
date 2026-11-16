#!/usr/bin/env node
/**
 * Importeur Supabase, réservé au serveur / à la machine de l'administrateur.
 *
 *   node scripts/import/push.mjs --source <jsonl>              # plan, aucune écriture
 *   node scripts/import/push.mjs --source <jsonl> --execute    # écrit dans le staging
 *   node scripts/import/push.mjs --run-id <uuid> --execute --resume
 *   node scripts/import/push.mjs --rollback <uuid> --execute
 *
 * Variables :
 *   SUPABASE_URL=https://<projet>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<clé service_role, jamais dans le navigateur>
 *
 * La clé service_role contourne les RLS : elle ne doit être ni committée, ni
 * exposée dans une variable préfixée VITE_/NEXT_PUBLIC_/PUBLIC_.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readHiliaJsonl } from './lib/read-jsonl.mjs';
import { buildPlaceDetail, reviewStatusOf } from './lib/normalize.mjs';
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
const BATCH = Math.max(1, Math.min(500, Number(arg('--batch', '200')) || 200));
const KINDS = new Set(String(arg('--kinds', 'place,event,activity,route')).split(',').map((s) => s.trim()).filter(Boolean));
const BASE = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TODAY = new Date().toISOString().slice(0, 10);

if (!BASE || !KEY) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis. Aucune clé service_role ne doit être exposée au navigateur.');
  process.exit(2);
}
if (!EXECUTE) {
  console.log(JSON.stringify({
    mode: 'plan',
    source: SOURCE,
    target: BASE,
    execute: false,
    batch: BATCH,
    kinds: [...KINDS],
    note: 'Relancer avec --execute pour écrire. La simulation complète se fait avec npm run import:simulate.',
  }, null, 2));
  process.exit(0);
}

const headers = {
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
};

async function request(path, options = {}, attempt = 0) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return request(path, options, attempt + 1);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const message = typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`Supabase ${res.status} sur ${path}: ${message.slice(0, 600)}`);
  }
  return data;
}

async function rpc(name, body) {
  return request(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

async function createRun(manifest) {
  const rows = await request('/rest/v1/hilia_import_runs', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify({
      source_name: SOURCE.split(/[\\/]/).pop(),
      schema_version: manifest?.schema_version || null,
      manifest: manifest || {},
      status: 'running',
    }),
  });
  return rows?.[0]?.id || null;
}

async function getRun(id) {
  const rows = await request(`/rest/v1/hilia_import_runs?id=eq.${encodeURIComponent(id)}&select=*`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchRun(id, patch) {
  await request(`/rest/v1/hilia_import_runs?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

async function batchJournal(runId, batchNo, checksum, count, inserted, updated) {
  await request('/rest/v1/hilia_import_batches?on_conflict=run_id,batch_no', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      run_id: runId,
      batch_no: batchNo,
      checksum,
      record_count: count,
      inserted_count: inserted,
      updated_count: updated,
      status: 'completed',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }),
  });
}

const snapshot = JSON.parse(await readFile(new URL('../../data/places.json', import.meta.url), 'utf8'));
const snapshotIds = new Set(snapshot.rows.map((row) => String(row[0])));

if (ROLLBACK) {
  const result = await rpc('hilia_import_rollback', { p_run_id: ROLLBACK });
  console.log(JSON.stringify({ mode: 'rollback', result }, null, 2));
  process.exit(0);
}

let runId = RUN_ID;
let cursor = 0;
let batchNo = 0;
let manifest = null;
if (RESUME) {
  if (!runId) throw new Error('--resume exige --run-id');
  const run = await getRun(runId);
  if (!run) throw new Error(`Run introuvable : ${runId}`);
  if (run.status === 'completed') { console.log('Ce run est déjà terminé.'); process.exit(0); }
  cursor = Number(run.cursor) || 0;
  manifest = run.manifest || null;
  const batches = await request(`/rest/v1/hilia_import_batches?run_id=eq.${encodeURIComponent(runId)}&select=batch_no&order=batch_no.desc&limit=1`);
  batchNo = Number(batches?.[0]?.batch_no) || 0;
  console.log(`Reprise du run ${runId} au curseur ${cursor}, lot ${batchNo}.`);
} else {
  // Le manifeste est la première ligne ; on le lit sans charger le fichier.
  for await (const { record } of readHiliaJsonl(SOURCE)) {
    if (record.kind === 'manifest') { manifest = record; break; }
  }
  runId = await createRun(manifest);
  if (!runId) throw new Error('Supabase n’a pas renvoyé l’identifiant du run.');
  console.log(`Run ${runId} créé.`);
}

const counts = { records: 0, skipped: 0, staged: 0, details: 0, batches: 0 };
let sourceIndex = 0;
let stagingBatch = [];
let detailBatch = [];
let stopped = false;

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

async function flushStaging() {
  if (!stagingBatch.length) return;
  const no = ++batchNo;
  const checksum = createHash('sha256').update(JSON.stringify(stagingBatch)).digest('hex');
  const result = await rpc('hilia_import_upsert', { p_run_id: runId, p_rows: stagingBatch });
  counts.staged += stagingBatch.length;
  counts.batches += 1;
  await batchJournal(runId, no, checksum, stagingBatch.length, Number(result?.inserted) || 0, Number(result?.updated) || 0);
  stagingBatch = [];
}

async function flushDetails() {
  if (!detailBatch.length) return;
  await rpc('hilia_upsert_place_details', { p_run_id: runId, p_rows: detailBatch });
  counts.details += detailBatch.length;
  detailBatch = [];
}

try {
for await (const { record } of readHiliaJsonl(SOURCE)) {
  sourceIndex += 1;
  if (sourceIndex <= cursor) continue;
  if (!record || record.kind === 'manifest' || record.kind === 'category') { counts.skipped += 1; continue; }
  if (!KINDS.has(record.kind)) { counts.skipped += 1; continue; }
  counts.records += 1;
  if (!record.id) { counts.skipped += 1; continue; }
  stagingBatch.push(rowOf(record));
  if (record.kind === 'place' && record.existing_hilia_id) {
    const detail = buildPlaceDetail(record, snapshotIds, TODAY);
    if (detail) detailBatch.push({
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
    });
  }
  if (stagingBatch.length >= BATCH) {
    await flushStaging();
    // Les détails doivent être persistés avant d'avancer le curseur : sinon
    // une reprise sauterait des enrichissements dont le lot n'a pas été écrit.
    if (detailBatch.length) await flushDetails();
  }
  if (detailBatch.length >= BATCH) await flushDetails();
  if (sourceIndex % 50 === 0) {
    // Le curseur ne représente que des lots déjà persistés. En cas de panne,
    // le curseur courant (et non sourceIndex) doit être conservé pour rejouer
    // le lot incomplet au lieu de le sauter.
    cursor = sourceIndex;
    await patchRun(runId, { cursor, counts });
  }
  if (LIMIT && counts.records >= LIMIT) { stopped = true; break; }
}

await flushStaging();
await flushDetails();
cursor = sourceIndex;
await patchRun(runId, { status: 'completed', cursor, counts, finished_at: new Date().toISOString() });
console.log(JSON.stringify({ mode: 'execute', runId, stopped, cursor: sourceIndex, counts }, null, 2));
} catch (error) {
  counts.error = String(error?.message || error).slice(0, 500);
  await patchRun(runId, { status: 'failed', cursor, counts, finished_at: new Date().toISOString() }).catch(function(){ /* le journal ne doit pas masquer l'erreur initiale */ });
  console.error('Import interrompu :', counts.error);
  throw error;
}
