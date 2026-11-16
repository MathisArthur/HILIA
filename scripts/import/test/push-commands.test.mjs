import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PUSH = path.join(ROOT, 'scripts/import/push.mjs');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body == null ? '' : JSON.stringify(body));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function makeMock() {
  const state = {
    runs: new Map(),
    records: new Map(),
    created: new Map(),
    batches: [],
    details: new Map(),
    history: new Map(),
    failOnce: true,
    failed: false,
  };
  state.details.set('1', {
    place_id: '1',
    description: 'Ancienne description',
    categories: [],
    media: [],
    hours: [],
    prices: null,
    contacts: null,
    accessibility: null,
    source_refs: [],
    licence_partition: [],
    is_public: true,
    import_run_id: null,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (url.pathname === '/__state') return json(res, 200, {
      runs: [...state.runs.values()],
      records: [...state.records.values()].length,
      details: [...state.details.values()],
      created: [...state.created.values()].flat(),
    });

    if (url.pathname === '/rest/v1/rpc/hilia_import_upsert') {
      if (state.failOnce && body?.p_rows?.some((row) => row.id === 'ext:65')) {
        state.failed = true;
        return json(res, 500, { message: 'panne simulée du lot' });
      }
      let inserted = 0;
      let updated = 0;
      for (const row of body?.p_rows || []) {
        const previous = state.records.get(row.id);
        state.records.set(row.id, { ...row, first_seen_run: previous?.first_seen_run || body.p_run_id, last_seen_run: body.p_run_id });
        if (previous) updated += 1;
        else {
          inserted += 1;
          if (!state.created.has(body.p_run_id)) state.created.set(body.p_run_id, new Set());
          state.created.get(body.p_run_id).add(row.id);
        }
      }
      return json(res, 200, { inserted, updated });
    }

    if (url.pathname === '/rest/v1/rpc/hilia_upsert_place_details') {
      for (const row of body?.p_rows || []) {
        const historyKey = `${body.p_run_id}:${row.place_id}`;
        if (!state.history.has(historyKey)) {
          const previous = state.details.get(row.place_id);
          state.history.set(historyKey, {
            previous_row: previous ? clone(previous) : null,
            created_new: !previous,
          });
        }
        state.details.set(row.place_id, {
          ...row,
          import_run_id: body.p_run_id,
          import_applied_at: new Date().toISOString(),
        });
      }
      return json(res, 200, { affected: (body?.p_rows || []).length });
    }

    if (url.pathname === '/rest/v1/rpc/hilia_import_rollback') {
      const runId = body?.p_run_id;
      let restored = 0;
      let deletedDetails = 0;
      for (const [key, entry] of state.history.entries()) {
        if (!key.startsWith(`${runId}:`)) continue;
        const placeId = key.slice(runId.length + 1);
        const current = state.details.get(placeId);
        if (!current || current.import_run_id !== runId) continue;
        if (entry.created_new) {
          state.details.delete(placeId);
          deletedDetails += 1;
        } else {
          state.details.set(placeId, entry.previous_row);
          restored += 1;
        }
        state.history.delete(key);
      }
      let deletedRecords = 0;
      for (const id of state.created.get(runId) || []) {
        const record = state.records.get(id);
        if (record && record.first_seen_run === runId && record.last_seen_run === runId) {
          state.records.delete(id);
          deletedRecords += 1;
        }
      }
      const run = state.runs.get(runId);
      if (run) run.status = 'rolled_back';
      return json(res, 200, { run_id: runId, restored_details: restored, deleted_new_details: deletedDetails, deleted_staging_records: deletedRecords });
    }

    if (url.pathname === '/rest/v1/hilia_import_runs' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const run = { id, ...body, cursor: 0, status: 'running' };
      state.runs.set(id, run);
      return json(res, 201, [run]);
    }

    if (url.pathname === '/rest/v1/hilia_import_runs' && req.method === 'GET') {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      return json(res, 200, state.runs.has(id) ? [state.runs.get(id)] : []);
    }

    if (url.pathname === '/rest/v1/hilia_import_runs' && req.method === 'PATCH') {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      const run = state.runs.get(id);
      if (run) Object.assign(run, body);
      return json(res, 204, null);
    }

    if (url.pathname === '/rest/v1/hilia_import_batches' && req.method === 'POST') {
      state.batches.push(body);
      return json(res, 201, []);
    }

    if (url.pathname === '/rest/v1/hilia_import_batches' && req.method === 'GET') {
      const runId = url.searchParams.get('run_id')?.replace(/^eq\./, '');
      const rows = state.batches.filter((b) => b.run_id === runId).sort((a, b) => b.batch_no - a.batch_no);
      return json(res, 200, rows.slice(0, 1).map((b) => ({ batch_no: b.batch_no })));
    }

    return json(res, 404, { message: `route mock inconnue ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, state, url: `http://127.0.0.1:${server.address().port}` };
}

function runPush(args, baseUrl, source) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PUSH, '--source', source, ...args], {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_URL: baseUrl, SUPABASE_SERVICE_ROLE_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function sourceFile(count) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hilia-push-'));
  const file = path.join(dir, 'source.jsonl');
  const lines = [JSON.stringify({ kind: 'manifest', schema_version: '1.0' })];
  lines.push(JSON.stringify({
    id: 'hilia:1', kind: 'place', existing_hilia_id: '1', publication_status: 'existing_preserved',
    name: 'Lieu existant', description: 'Nouvelle description', categories: ['Musée'],
    sources: [{ source: 'hilia', source_id: '1', licence: 'existing_internal' }],
    media: [], accessibility_observations: [], details_by_source: {},
  }));
  for (let i = 1; i <= count; i += 1) {
    lines.push(JSON.stringify({
      id: `ext:${i}`, kind: 'place', publication_status: 'review_accessibility',
      name: `Lieu ${i}`, address: '1 rue de Test', postal_code: '75001', commune: 'Paris',
      coordinates: { latitude: 48.86, longitude: 2.35 }, categories: ['Musée'],
      sources: [{ source: 'datatourisme', source_id: `ext:${i}`, licence: 'etalab-open-licence' }],
      media: [], accessibility_observations: [], details_by_source: {},
    }));
  }
  await writeFile(file, lines.join('\n') + '\n');
  return { dir, file };
}

test('push échoue proprement, reprend et rollback restaure le détail existant', async (t) => {
  const mock = await makeMock();
  const source = await sourceFile(70);
  t.after(async () => {
    await new Promise((resolve) => mock.server.close(resolve));
    await rm(source.dir, { recursive: true, force: true });
  });

  const first = await runPush(['--execute', '--batch=10'], mock.url, source.file);
  assert.notEqual(first.code, 0, first.stderr);
  assert.equal(mock.state.failed, true);
  const failedRun = [...mock.state.runs.values()][0];
  assert.ok(failedRun, 'un run doit être journalisé');
  assert.equal(failedRun.status, 'failed');
  assert.ok(failedRun.cursor > 0, `curseur attendu > 0, reçu ${failedRun.cursor}`);

  mock.state.failOnce = false;
  const resumed = await runPush(['--execute', '--resume', '--run-id', failedRun.id, '--batch=10'], mock.url, source.file);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal([...mock.state.runs.values()][0].status, 'completed');
  assert.equal(mock.state.records.size, 71);
  assert.equal(mock.state.details.get('1').description, 'Nouvelle description');

  const rolled = await runPush(['--execute', '--rollback', failedRun.id], mock.url, source.file);
  assert.equal(rolled.code, 0, rolled.stderr);
  assert.equal(mock.state.details.get('1').description, 'Ancienne description');
  assert.equal(mock.state.details.get('1').import_run_id, null);
  assert.equal(mock.state.details.has('ext:1'), false);
  assert.equal([...mock.state.runs.values()][0].status, 'rolled_back');
});
