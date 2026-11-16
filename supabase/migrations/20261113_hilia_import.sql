-- HILIA - import des données enrichies.
--
-- À exécuter dans Supabase → SQL Editor, en une fois, après sauvegarde.
-- Aucune table existante n'est remplacée. Les identifiants de hilia_places ne
-- sont pas convertis : les correspondances sont conservées en texte.
--
-- Les tables hilia_import_* sont des tables de travail. Elles ne sont pas
-- lisibles avec la clé publishable. Le service_role les alimente.
-- Les tables hilia_place_details / hilia_events / ... ne sont publiques que pour
-- les lignes explicitement approuvées (is_public = true).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Journal d'import, lots et reprise
-- ---------------------------------------------------------------------------
create table if not exists public.hilia_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_sha256 text,
  schema_version text,
  manifest jsonb not null default '{}'::jsonb,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'rolled_back')),
  cursor integer not null default 0,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.hilia_import_batches (
  id bigserial primary key,
  run_id uuid not null references public.hilia_import_runs(id) on delete cascade,
  batch_no integer not null,
  checksum text,
  record_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, batch_no)
);

create table if not exists public.hilia_import_records (
  id text primary key,
  kind text not null check (kind in ('place', 'event', 'activity', 'route')),
  source text not null,
  source_id text not null,
  existing_hilia_id text,
  name text,
  commune text,
  postal_code text,
  publication_status text,
  review_status text not null default 'pending',
  payload jsonb not null,
  first_seen_run uuid references public.hilia_import_runs(id) on delete set null,
  last_seen_run uuid references public.hilia_import_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id)
);

create index if not exists hilia_import_records_kind_idx on public.hilia_import_records(kind, review_status);
create index if not exists hilia_import_records_existing_idx on public.hilia_import_records(existing_hilia_id);
create index if not exists hilia_import_batches_run_idx on public.hilia_import_batches(run_id, batch_no);

-- Ne consigne que les lignes réellement créées par un lot : un rollback ne
-- supprime jamais une ligne qui existait avant, ni une ligne mise à jour depuis.
create table if not exists public.hilia_import_created (
  run_id uuid not null references public.hilia_import_runs(id) on delete cascade,
  record_id text not null,
  entity_kind text not null default 'source_record',
  created_at timestamptz not null default now(),
  primary key (run_id, record_id, entity_kind)
);

-- ---------------------------------------------------------------------------
-- Détails publics des lieux existants (chargés à la demande par le site)
-- ---------------------------------------------------------------------------
create table if not exists public.hilia_place_details (
  place_id text primary key,
  description text,
  description_source jsonb,
  categories jsonb not null default '[]'::jsonb,
  media jsonb not null default '[]'::jsonb,
  hours jsonb not null default '[]'::jsonb,
  prices jsonb,
  contacts jsonb,
  accessibility jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  licence_partition text[] not null default '{}',
  is_public boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Entités distinctes : événements, activités, itinéraires
-- ---------------------------------------------------------------------------
create table if not exists public.hilia_events (
  id text primary key,
  name text not null,
  description text,
  commune text,
  postal_code text,
  address text,
  latitude double precision,
  longitude double precision,
  categories jsonb not null default '[]'::jsonb,
  starts_on date,
  ends_on date,
  start_time time,
  end_time time,
  is_free boolean,
  prices jsonb,
  booking_url text,
  website text,
  contacts jsonb,
  hours jsonb not null default '[]'::jsonb,
  media jsonb not null default '[]'::jsonb,
  accessibility jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  licence_partition text[] not null default '{}',
  publication_status text,
  review_status text not null default 'pending',
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

create table if not exists public.hilia_leisure_activities (
  id text primary key,
  name text not null,
  description text,
  commune text,
  postal_code text,
  address text,
  latitude double precision,
  longitude double precision,
  categories jsonb not null default '[]'::jsonb,
  duration_minutes integer,
  booking_url text,
  website text,
  contacts jsonb,
  media jsonb not null default '[]'::jsonb,
  accessibility jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  licence_partition text[] not null default '{}',
  publication_status text,
  review_status text not null default 'pending',
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hilia_routes (
  id text primary key,
  name text not null,
  description text,
  commune text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  categories jsonb not null default '[]'::jsonb,
  distance_meters integer,
  duration_minutes integer,
  difficulty text,
  geometry jsonb,
  website text,
  media jsonb not null default '[]'::jsonb,
  accessibility jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  licence_partition text[] not null default '{}',
  publication_status text,
  review_status text not null default 'pending',
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hilia_media (
  id bigserial primary key,
  entity_id text not null,
  entity_kind text not null check (entity_kind in ('place', 'event', 'activity', 'route')),
  url text not null,
  credit text,
  rights_status text not null,
  rights_start date,
  rights_end date,
  source_ref text,
  licence text,
  width integer,
  height integer,
  alt_text text,
  position integer not null default 0,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (rights_status in ('eligible_with_credit', 'review_rights_or_format', 'review_image_rights', 'expired', 'not_yet_valid'))
);

create index if not exists hilia_events_dates_idx on public.hilia_events(starts_on, ends_on) where is_public;
create index if not exists hilia_events_commune_idx on public.hilia_events(commune) where is_public;
create index if not exists hilia_media_entity_idx on public.hilia_media(entity_kind, entity_id);
create index if not exists hilia_place_details_public_idx on public.hilia_place_details(is_public);

-- ---------------------------------------------------------------------------
-- Mise à jour de updated_at
-- ---------------------------------------------------------------------------
create or replace function public.hilia_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'hilia_import_runs', 'hilia_import_records', 'hilia_place_details',
    'hilia_events', 'hilia_leisure_activities', 'hilia_routes', 'hilia_media'
  ] loop
    execute format('drop trigger if exists %I_touch on public.%I', t, t);
    execute format('create trigger %I_touch before update on public.%I for each row execute function public.hilia_touch_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Import idempotent par lot
-- ---------------------------------------------------------------------------
create or replace function public.hilia_import_upsert(p_run_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
  updated_count integer := 0;
begin
  if p_run_id is null then raise exception 'run_id manquant'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows doit être un tableau JSON'; end if;

  with input as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      id text, kind text, source text, source_id text, existing_hilia_id text,
      name text, commune text, postal_code text, publication_status text,
      review_status text, payload jsonb
    )
  ), upserted as (
    insert into public.hilia_import_records (
      id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, review_status, payload, first_seen_run, last_seen_run
    )
    select id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, coalesce(review_status, 'pending'), payload, p_run_id, p_run_id
    from input
    on conflict (id) do update set
      kind = excluded.kind,
      source = excluded.source,
      source_id = excluded.source_id,
      existing_hilia_id = excluded.existing_hilia_id,
      name = excluded.name,
      commune = excluded.commune,
      postal_code = excluded.postal_code,
      publication_status = excluded.publication_status,
      review_status = excluded.review_status,
      payload = excluded.payload,
      last_seen_run = excluded.last_seen_run,
      updated_at = now()
    returning id, (xmax = 0) as was_inserted
  ), logged as (
    insert into public.hilia_import_created (run_id, record_id, entity_kind)
    select p_run_id, id, 'source_record' from upserted where was_inserted
    on conflict do nothing
    returning 1
  )
  select
    count(*) filter (where was_inserted),
    count(*) filter (where not was_inserted)
  into inserted_count, updated_count
  from upserted;

  return jsonb_build_object('inserted', inserted_count, 'updated', updated_count);
end;
$$;

create or replace function public.hilia_upsert_place_details(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows doit être un tableau JSON'; end if;
  insert into public.hilia_place_details (
    place_id, description, description_source, categories, media, hours, prices,
    contacts, accessibility, source_refs, licence_partition, is_public
  )
  select
    x.place_id, x.description, x.description_source, coalesce(x.categories, '[]'::jsonb),
    coalesce(x.media, '[]'::jsonb), coalesce(x.hours, '[]'::jsonb), x.prices,
    x.contacts, x.accessibility, coalesce(x.source_refs, '[]'::jsonb),
    coalesce(x.licence_partition, '{}'), exists (
      select 1 from public.hilia_places p
      where p.id::text = x.place_id and p.status = 'approved'
    )
  from jsonb_to_recordset(p_rows) as x(
    place_id text, description text, description_source jsonb, categories jsonb,
    media jsonb, hours jsonb, prices jsonb, contacts jsonb, accessibility jsonb,
    source_refs jsonb, licence_partition text[]
  )
  on conflict (place_id) do update set
    description = excluded.description,
    description_source = excluded.description_source,
    categories = excluded.categories,
    media = excluded.media,
    hours = excluded.hours,
    prices = excluded.prices,
    contacts = excluded.contacts,
    accessibility = excluded.accessibility,
    source_refs = excluded.source_refs,
    licence_partition = excluded.licence_partition,
    is_public = excluded.is_public,
    updated_at = now();
  get diagnostics affected = row_count;
  return jsonb_build_object('affected', affected);
end;
$$;

create or replace function public.hilia_import_rollback(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare deleted integer := 0;
begin
  with removable as (
    delete from public.hilia_import_records r
    using public.hilia_import_created c
    where c.run_id = p_run_id
      and c.entity_kind = 'source_record'
      and r.id = c.record_id
      and r.first_seen_run = p_run_id
      and r.last_seen_run = p_run_id
    returning r.id
  )
  select count(*) into deleted from removable;
  update public.hilia_import_runs
    set status = 'rolled_back', finished_at = now()
    where id = p_run_id;
  return jsonb_build_object('deleted', deleted, 'run_id', p_run_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS : le staging reste privé, le public ne voit que l'approuvé
-- ---------------------------------------------------------------------------
alter table public.hilia_import_runs enable row level security;
alter table public.hilia_import_batches enable row level security;
alter table public.hilia_import_records enable row level security;
alter table public.hilia_import_created enable row level security;
alter table public.hilia_place_details enable row level security;
alter table public.hilia_events enable row level security;
alter table public.hilia_leisure_activities enable row level security;
alter table public.hilia_routes enable row level security;
alter table public.hilia_media enable row level security;

revoke all on public.hilia_import_runs, public.hilia_import_batches,
  public.hilia_import_records, public.hilia_import_created from anon, authenticated;
revoke insert, update, delete on public.hilia_place_details, public.hilia_events,
  public.hilia_leisure_activities, public.hilia_routes, public.hilia_media from anon, authenticated;

grant select on public.hilia_place_details, public.hilia_events,
  public.hilia_leisure_activities, public.hilia_routes, public.hilia_media to anon, authenticated;

-- Les fonctions SECURITY DEFINER ne doivent jamais être appelables par un
-- visiteur : sans ce retrait, anon pourrait écrire dans le staging ou lancer
-- un rollback avec la clé publishable.
revoke execute on function public.hilia_import_upsert(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.hilia_upsert_place_details(jsonb) from public, anon, authenticated;
revoke execute on function public.hilia_import_rollback(uuid) from public, anon, authenticated;
revoke execute on function public.hilia_touch_updated_at() from public, anon, authenticated;
grant execute on function public.hilia_import_upsert(uuid, jsonb) to service_role;
grant execute on function public.hilia_upsert_place_details(jsonb) to service_role;
grant execute on function public.hilia_import_rollback(uuid) to service_role;

drop policy if exists hilia_place_details_public_read on public.hilia_place_details;
create policy hilia_place_details_public_read on public.hilia_place_details
  for select to anon, authenticated
  using (is_public and exists (
    select 1 from public.hilia_places p
    where p.id::text = hilia_place_details.place_id and p.status = 'approved'
  ));

drop policy if exists hilia_events_public_read on public.hilia_events;
create policy hilia_events_public_read on public.hilia_events
  for select to anon, authenticated
  using (is_public and review_status = 'approved');

drop policy if exists hilia_activities_public_read on public.hilia_leisure_activities;
create policy hilia_activities_public_read on public.hilia_leisure_activities
  for select to anon, authenticated
  using (is_public and review_status = 'approved');

drop policy if exists hilia_routes_public_read on public.hilia_routes;
create policy hilia_routes_public_read on public.hilia_routes
  for select to anon, authenticated
  using (is_public and review_status = 'approved');

drop policy if exists hilia_media_public_read on public.hilia_media;
create policy hilia_media_public_read on public.hilia_media
  for select to anon, authenticated
  using (is_public and rights_status = 'eligible_with_credit'
    and (rights_start is null or rights_start <= current_date)
    and (rights_end is null or rights_end >= current_date));

-- service_role contourne RLS : ne jamais exposer cette clé au navigateur.
comment on table public.hilia_import_records is
  'Staging des candidats. Aucun accès anon/authenticated : promotion explicite après revue.';
comment on column public.hilia_place_details.is_public is
  'Calculé par hilia_upsert_place_details : vrai seulement si hilia_places.status = approved.';
