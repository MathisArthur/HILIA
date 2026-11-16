#!/usr/bin/env node
/**
 * Test d'intégration PostgreSQL réel (hors `npm run test:import`).
 *
 * Prérequis, sans modifier le package.json :
 *   npm install --no-save --package-lock=false embedded-postgres
 *   node scripts/import/test/postgres-review.mjs
 *
 * Le cluster est temporaire et arrêté à la fin. Ce test crée le socle minimal
 * de hilia_places et de auth.uid(), puis applique les quatre migrations dans
 * l'ordre. Il ne se connecte à aucun projet Supabase et n'utilise aucune clé.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS = [
  'supabase/migrations/20261113_hilia_import.sql',
  'supabase/migrations/20261114_hilia_review.sql',
  'supabase/migrations/20261116_hilia_restore_public_read.sql',
  'supabase/migrations/20261117_hilia_review_fixes.sql',
];
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

const bootstrap = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table if not exists public.hilia_user_roles (
  user_id uuid primary key,
  role text not null
);
-- Socle minimal de la table existante, absent des migrations d'import.
create table if not exists public.hilia_places (
  id text primary key,
  name text not null,
  activity text,
  address text,
  cp text,
  commune text,
  site text,
  lat double precision,
  lon double precision,
  status text not null default 'pending',
  approved_at timestamptz,
  author_name text,
  data_origin text,
  access jsonb
);
insert into public.hilia_places (id, name, status, access)
values ('1', 'Lieu existant', 'approved', '{"8":1}'::jsonb)
on conflict (id) do nothing;
insert into public.hilia_user_roles (user_id, role)
values ('${ADMIN_ID}'::uuid, 'admin')
on conflict (user_id) do update set role = excluded.role;
`;

function json(value) {
  return JSON.stringify(value);
}

const approval = {
  name: 'Nouveau lieu test',
  activity: 'Musée',
  address: '10 rue du Test',
  postal_code: '75001',
  commune: 'Paris',
  site: 'https://exemple.test/nouveau',
  latitude: 48.86,
  longitude: 2.35,
  access: { 21: 1, 23: 2, 28: 90, _unknown: false },
  detail: {
    description: 'Description approuvée',
    categories: [{ name: 'Musée', family: 'Culture et patrimoine' }],
    media: [{
      url: 'https://exemple.test/photo.jpg',
      credit: 'Photographe test',
      source: 'Acceslibre',
      sourceRef: 'acceslibre:new',
      licence: 'Licence Ouverte 2.0',
    }],
    hours: [],
    prices: null,
    contacts: { emails: [], phones: [], websites: ['https://exemple.test/nouveau'], legalNames: [], sourceRefs: [] },
    accessibility: {
      observations: [{ source: 'Acceslibre', values: { entree_plain_pied: true } }],
      _unknown: false,
    },
    sourceRefs: [{ label: 'Acceslibre', licence: 'Licence Ouverte 2.0' }],
    licencePartition: ['etalab-open-licence'],
  },
};

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hilia-pg-review-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: 55432,
    persistent: false,
    autoRehydrateSymlinks: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  let client;
  try {
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient();
    await client.connect();
    await client.query(bootstrap);
    await client.query(`set request.jwt.claim.sub = '${ADMIN_ID}'`);

    for (const file of MIGRATIONS) {
      const sql = await readFile(path.join(ROOT, file), 'utf8');
      await client.query(sql);
    }
    // La migration corrective doit pouvoir être rejouée sans erreur.
    await client.query(await readFile(path.join(ROOT, MIGRATIONS.at(-1)), 'utf8'));

    const runId = randomUUID();
    await client.query(
      `insert into public.hilia_import_runs (id, source_name, schema_version, status)
       values ($1, 'postgres-review', '1.0', 'running')`,
      [runId],
    );

    const records = [
      {
        id: 'ext:new', kind: 'place', source: 'test', source_id: 'new', existing_hilia_id: null,
        name: 'Nouveau lieu test', commune: 'Paris', postal_code: '75001',
        publication_status: 'review_accessibility', review_status: 'accessibility_review',
        auto_publishable: false, review_level: 'manual', review_reasons: [],
        approval,
        payload: {
          kind: 'place', id: 'ext:new', name: 'Nouveau lieu test', categories: ['Musée'],
          websites: ['https://exemple.test/nouveau'], coordinates: { latitude: 48.86, longitude: 2.35 },
          address: '10 rue du Test', postal_code: '75001', commune: 'Paris', sources: [],
        },
      },
      {
        id: 'ext:raw', kind: 'place', source: 'test', source_id: 'raw', existing_hilia_id: null,
        name: 'Lieu brut', commune: 'Lyon', postal_code: '69001',
        publication_status: 'review_accessibility', review_status: 'accessibility_review',
        auto_publishable: false, review_level: 'manual', review_reasons: [],
        payload: {
          kind: 'place', id: 'ext:raw', name: 'Lieu brut', categories: ['Parc'],
          websites: ['https://exemple.test/brut'], coordinates: { latitude: '45.76', longitude: '4.83' },
          address: '1 place Brute', postal_code: '69001', commune: 'Lyon', sources: [],
        },
      },
      {
        id: 'ext:activity', kind: 'activity', source: 'test', source_id: 'activity', existing_hilia_id: null,
        name: 'Activité test', commune: 'Paris', publication_status: 'candidate_activity',
        review_status: 'manual', auto_publishable: false, review_level: 'manual', review_reasons: [],
        payload: { kind: 'activity', id: 'ext:activity', name: 'Activité test' },
      },
      {
        id: 'ext:route', kind: 'route', source: 'test', source_id: 'route', existing_hilia_id: null,
        name: 'Itinéraire test', commune: 'Paris', publication_status: 'candidate_route',
        review_status: 'manual', auto_publishable: false, review_level: 'manual', review_reasons: [],
        payload: { kind: 'route', id: 'ext:route', name: 'Itinéraire test' },
      },
    ];
    await client.query('select public.hilia_import_upsert($1, $2::jsonb)', [runId, json(records)]);

    const futureId = 'place_imp_' + createHash('md5').update('ext:new').digest('hex').slice(0, 20);
    await client.query(
      'select public.hilia_upsert_place_details($1, $2::jsonb)',
      [runId, json([{ place_id: futureId, description: 'Description préparée', accessibility: { _unknown: true }, is_public: false }])],
    );
    const before = await client.query('select is_public from public.hilia_place_details where place_id = $1', [futureId]);
    assert.equal(before.rows[0].is_public, false, 'le détail futur doit rester privé avant approbation');

    const empty = await client.query("select public.hilia_admin_review_decision(null::text[], 'approve') as result");
    assert.equal(empty.rows[0].result.published_places, 0);
    assert.match(empty.rows[0].result.note_published, /Aucun identifiant/);
    const emptyArray = await client.query("select public.hilia_admin_review_decision(array[]::text[], 'approve') as result");
    assert.equal(emptyArray.rows[0].result.published_places, 0);

    const decision = await client.query(
      "select public.hilia_admin_review_decision(array['ext:new','ext:raw','ext:activity','ext:route']::text[], 'approve', 'test') as result",
    );
    assert.equal(decision.rows[0].result.published_places, 2, 'les deux lieux sont publiés');
    assert.equal(decision.rows[0].result.approved_activities_staged, 1);
    assert.equal(decision.rows[0].result.approved_routes_staged, 1);

    const place = await client.query('select * from public.hilia_places where id = $1', [futureId]);
    assert.equal(place.rows[0].name, 'Nouveau lieu test');
    assert.equal(place.rows[0].activity, 'Musée');
    assert.equal(place.rows[0].site, 'https://exemple.test/nouveau');
    assert.equal(place.rows[0].lat, 48.86);
    assert.equal(place.rows[0].access['21'], 1);
    assert.equal(place.rows[0].access._unknown, false);
    const raw = await client.query("select * from public.hilia_places where id = 'place_imp_' || substr(md5('ext:raw'), 1, 20)");
    assert.equal(raw.rows[0].activity, 'Parc', 'catégorie chaîne du payload brut');
    assert.equal(raw.rows[0].site, 'https://exemple.test/brut');
    assert.equal(raw.rows[0].lat, 45.76);
    assert.equal(raw.rows[0].access._unknown, true, 'absence d’accessibilité explicite');

    const detail = await client.query('select * from public.hilia_place_details where place_id = $1', [futureId]);
    assert.equal(detail.rows[0].is_public, true);
    assert.equal(detail.rows[0].description, 'Description approuvée', 'le détail préparé est transféré');
    assert.equal(detail.rows[0].media[0].credit, 'Photographe test', 'le crédit de la photo est conservé');
    assert.equal(detail.rows[0].accessibility._unknown, false);
    assert.equal(detail.rows[0].licence_partition[0], 'etalab-open-licence');

    const surfaces = await client.query(
      "select id, publication_surface, published_at from public.hilia_import_records where id in ('ext:new','ext:activity','ext:route') order by id",
    );
    assert.equal(surfaces.rows.find((row) => row.id === 'ext:new').publication_surface, 'hilia_places');
    assert.equal(surfaces.rows.find((row) => row.id === 'ext:activity').publication_surface, 'staging_only');
    assert.equal(surfaces.rows.find((row) => row.id === 'ext:route').publication_surface, 'staging_only');
    assert.equal(surfaces.rows.find((row) => row.id === 'ext:route').published_at, null);

    // Rollback : restaure un détail existant, supprime un détail créé, ne
    // supprime pas la fiche publique approuvée.
    await client.query("insert into public.hilia_place_details (place_id, description, is_public) values ('1', 'Ancienne description', true)");
    const rollbackRun = randomUUID();
    await client.query(
      "insert into public.hilia_import_runs (id, source_name, schema_version, status) values ($1, 'rollback-review', '1.0', 'running')",
      [rollbackRun],
    );
    await client.query(
      'select public.hilia_upsert_place_details($1, $2::jsonb)',
      [rollbackRun, json([
        { place_id: '1', description: 'Description importée', is_public: true },
        { place_id: futureId, description: 'Détail à supprimer', is_public: false },
        { place_id: 'place_imp_rollback_only', description: 'Nouveau détail', is_public: false },
      ])],
    );
    const rolled = await client.query('select public.hilia_import_rollback($1) as result', [rollbackRun]);
    assert.equal(rolled.rows[0].result.restored_details, 2);
    assert.equal(rolled.rows[0].result.deleted_new_details, 1);
    const restored = await client.query("select description from public.hilia_place_details where place_id = '1'");
    assert.equal(restored.rows[0].description, 'Ancienne description');
    const stillThere = await client.query('select count(*)::int as n from public.hilia_places where id = $1', [futureId]);
    assert.equal(stillThere.rows[0].n, 1, 'le rollback ne supprime pas la fiche publique');
    const deletedDetail = await client.query("select count(*)::int as n from public.hilia_place_details where place_id = 'place_imp_rollback_only'");
    assert.equal(deletedDetail.rows[0].n, 0, 'le détail créé par le run est supprimé');

    console.log('PostgreSQL réel : migrations, approbation, transfert, surfaces et rollback OK');
  } finally {
    if (client) await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});