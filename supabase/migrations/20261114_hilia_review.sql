-- HILIA - revue des nouveaux contenus et rollback des enrichissements.
--
-- À exécuter APRÈS 20261113_hilia_import.sql, dans le même projet Supabase.
-- Aucune fiche publique existante n'est supprimée ou renumérotée.
--
-- Principe : aucun nouveau lieu, activité ou itinéraire n'est publié
-- automatiquement. L'administration approuve ou refuse les candidats par lots.
-- Une approbation de lieu crée une fiche hilia_places avec accessibilité
-- explicitement inconnue ; elle ne devient visible dans le catalogue statique
-- qu'après `npm run data`.

begin;

-- ---------------------------------------------------------------------------
-- Journal de revue
-- ---------------------------------------------------------------------------
alter table public.hilia_import_records
  add column if not exists auto_publishable boolean not null default false,
  add column if not exists review_level text not null default 'manual',
  add column if not exists review_reasons jsonb not null default '[]'::jsonb,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists published_place_id text;

create index if not exists hilia_import_records_review_idx
  on public.hilia_import_records(kind, review_level, review_status, created_at desc);

-- ---------------------------------------------------------------------------
-- Historique des détails de lieux, pour restaurer une fiche enrichie
-- ---------------------------------------------------------------------------
alter table public.hilia_place_details
  add column if not exists import_run_id uuid,
  add column if not exists import_applied_at timestamptz;

create table if not exists public.hilia_place_detail_history (
  run_id uuid not null references public.hilia_import_runs(id) on delete cascade,
  place_id text not null,
  previous_row jsonb,
  created_new boolean not null default false,
  saved_at timestamptz not null default now(),
  primary key (run_id, place_id)
);

alter table public.hilia_place_detail_history enable row level security;
revoke all on public.hilia_place_detail_history from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Upsert du staging avec les champs de revue
-- ---------------------------------------------------------------------------
create or replace function public.hilia_import_upsert(p_run_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
      review_status text, auto_publishable boolean, review_level text,
      review_reasons jsonb, payload jsonb
    )
  ), upserted as (
    insert into public.hilia_import_records (
      id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, review_status, auto_publishable, review_level,
      review_reasons, payload, first_seen_run, last_seen_run
    )
    select id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, coalesce(review_status, 'pending'),
      coalesce(auto_publishable, false), coalesce(review_level, 'manual'),
      coalesce(review_reasons, '[]'::jsonb), payload, p_run_id, p_run_id
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
      -- Une décision humaine déjà prise n'est jamais annulée par un réimport.
      review_status = case
        when hilia_import_records.review_status in ('approved', 'rejected')
          then hilia_import_records.review_status
        else excluded.review_status
      end,
      auto_publishable = excluded.auto_publishable,
      review_level = excluded.review_level,
      review_reasons = excluded.review_reasons,
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

revoke execute on function public.hilia_import_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hilia_import_upsert(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Détails : capturer l'état précédent, puis appliquer l'enrichissement
-- ---------------------------------------------------------------------------
create or replace function public.hilia_upsert_place_details(p_run_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  if p_run_id is null then raise exception 'run_id manquant'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows doit être un tableau JSON'; end if;

  insert into public.hilia_place_detail_history (run_id, place_id, previous_row, created_new)
  select p_run_id, x.place_id, to_jsonb(d), d.place_id is null
  from jsonb_to_recordset(p_rows) as x(place_id text)
  left join public.hilia_place_details d on d.place_id = x.place_id
  on conflict (run_id, place_id) do nothing;

  insert into public.hilia_place_details (
    place_id, description, description_source, categories, media, hours, prices,
    contacts, accessibility, source_refs, licence_partition, is_public,
    import_run_id, import_applied_at
  )
  select
    x.place_id, x.description, x.description_source, coalesce(x.categories, '[]'::jsonb),
    coalesce(x.media, '[]'::jsonb), coalesce(x.hours, '[]'::jsonb), x.prices,
    x.contacts, x.accessibility, coalesce(x.source_refs, '[]'::jsonb),
    coalesce(x.licence_partition, '{}'), exists (
      select 1 from public.hilia_places p
      where p.id::text = x.place_id and p.status = 'approved'
    ), p_run_id, now()
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
    import_run_id = excluded.import_run_id,
    import_applied_at = excluded.import_applied_at,
    updated_at = now();
  get diagnostics affected = row_count;
  return jsonb_build_object('affected', affected);
end;
$$;

revoke execute on function public.hilia_upsert_place_details(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hilia_upsert_place_details(uuid, jsonb) to service_role;
-- Ancienne signature de la première migration : ne pas l'utiliser.
revoke execute on function public.hilia_upsert_place_details(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rollback : restaurer les détails et supprimer uniquement les nouveautés
-- ---------------------------------------------------------------------------
create or replace function public.hilia_import_rollback(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  restored integer := 0;
  deleted_details integer := 0;
  deleted_records integer := 0;
begin
  if p_run_id is null then raise exception 'run_id manquant'; end if;

  with restored_rows as (
    update public.hilia_place_details d
    set
      description = h.previous_row->>'description',
      description_source = case when h.previous_row is null then null else h.previous_row->'description_source' end,
      categories = coalesce(h.previous_row->'categories', '[]'::jsonb),
      media = coalesce(h.previous_row->'media', '[]'::jsonb),
      hours = coalesce(h.previous_row->'hours', '[]'::jsonb),
      prices = case when h.previous_row is null then null else h.previous_row->'prices' end,
      contacts = case when h.previous_row is null then null else h.previous_row->'contacts' end,
      accessibility = case when h.previous_row is null then null else h.previous_row->'accessibility' end,
      source_refs = coalesce(h.previous_row->'source_refs', '[]'::jsonb),
      licence_partition = case
        when h.previous_row is null then '{}'::text[]
        else coalesce(
          (select array_agg(value) from jsonb_array_elements_text(h.previous_row->'licence_partition') value),
          '{}'::text[]
        )
      end,
      is_public = coalesce((h.previous_row->>'is_public')::boolean, false),
      import_run_id = case when h.previous_row is null then null else (h.previous_row->>'import_run_id') end,
      import_applied_at = coalesce((h.previous_row->>'import_applied_at')::timestamptz, now()),
      updated_at = now()
    from public.hilia_place_detail_history h
    where h.run_id = p_run_id
      and h.created_new = false
      and d.place_id = h.place_id
      and d.import_run_id = p_run_id
    returning d.place_id
  )
  select count(*) into restored from restored_rows;

  with deleted_details_rows as (
    delete from public.hilia_place_details d
    using public.hilia_place_detail_history h
    where h.run_id = p_run_id
      and h.created_new = true
      and d.place_id = h.place_id
      and d.import_run_id = p_run_id
    returning d.place_id
  )
  select count(*) into deleted_details from deleted_details_rows;

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
  select count(*) into deleted_records from removable;

  update public.hilia_import_runs
    set status = 'rolled_back', finished_at = now()
    where id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'restored_details', restored,
    'deleted_new_details', deleted_details,
    'deleted_staging_records', deleted_records,
    'note', 'Les fiches hilia_places et les contenus publiés après le run ne sont pas supprimés.'
  );
end;
$$;

revoke execute on function public.hilia_import_rollback(uuid) from public, anon, authenticated;
grant execute on function public.hilia_import_rollback(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Administration : lecture et décision par lots
-- ---------------------------------------------------------------------------
create or replace function public.hilia_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.hilia_user_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

revoke execute on function public.hilia_is_admin() from public, anon;
grant execute on function public.hilia_is_admin() to authenticated;

create or replace function public.hilia_admin_review_queue(
  p_kind text default null,
  p_level text default null,
  p_limit integer default 30,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  total integer := 0;
  counts jsonb := '{}'::jsonb;
  items jsonb := '[]'::jsonb;
  lim integer := greatest(1, least(100, coalesce(p_limit, 30)));
  off integer := greatest(0, coalesce(p_offset, 0));
begin
  if not public.hilia_is_admin() then
    raise exception using errcode = '42501', message = 'Administration requise';
  end if;

  select count(*) into total
  from public.hilia_import_records
  where kind in ('place', 'activity', 'route')
    and review_status not in ('approved', 'rejected')
    and (p_kind is null or kind = p_kind)
    and (p_level is null or review_level = p_level);

  select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) into counts
  from (
    select kind, count(*)::integer as n
    from public.hilia_import_records
    where kind in ('place', 'activity', 'route')
      and review_status not in ('approved', 'rejected')
      and (p_kind is null or kind = p_kind)
      and (p_level is null or review_level = p_level)
    group by kind
  ) c;

  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into items
  from (
    select
      r.id, r.kind, r.source, r.source_id, r.name, r.commune, r.postal_code,
      r.publication_status, r.review_status, r.review_level, r.auto_publishable,
      r.review_reasons, r.existing_hilia_id, r.published_place_id,
      r.payload->'sources' as sources,
      r.payload->'categories' as categories,
      r.created_at
    from public.hilia_import_records r
    where r.kind in ('place', 'activity', 'route')
      and r.review_status not in ('approved', 'rejected')
      and (p_kind is null or r.kind = p_kind)
      and (p_level is null or r.review_level = p_level)
    order by r.created_at desc
    limit lim offset off
  ) q;

  return jsonb_build_object('total', total, 'counts', counts, 'items', items);
end;
$$;

revoke execute on function public.hilia_admin_review_queue(text, text, integer, integer) from public, anon;
grant execute on function public.hilia_admin_review_queue(text, text, integer, integer) to authenticated;

create or replace function public.hilia_admin_review_decision(
  p_ids text[],
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  approved integer := 0;
  rejected integer := 0;
  needs_review integer := 0;
  published integer := 0;
begin
  if not public.hilia_is_admin() then
    raise exception using errcode = '42501', message = 'Administration requise';
  end if;
  if p_decision not in ('approve', 'reject', 'needs_review') then
    raise exception 'Décision inconnue : %', p_decision;
  end if;
  if p_ids is null or not array_length(p_ids, 1) then
    return jsonb_build_object('approved', 0, 'rejected', 0, 'needs_review', 0, 'published_places', 0);
  end if;

  if p_decision = 'approve' then
    insert into public.hilia_places (
      id, name, activity, address, cp, commune, site, lat, lon,
      status, approved_at, author_name, data_origin, access
    )
    select
      'place_imp_' || substr(md5(r.id), 1, 20),
      r.name,
      coalesce(nullif(r.payload->'categories'->0->>'name', ''), 'Sports et loisirs'),
      coalesce(r.payload->>'address', ''),
      coalesce(r.payload->>'postal_code', ''),
      coalesce(r.payload->>'commune', ''),
      nullif(r.payload->'contacts'->'websites'->>0, ''),
      nullif(r.payload->'coordinates'->>'latitude', '')::double precision,
      nullif(r.payload->'coordinates'->>'longitude', '')::double precision,
      'approved', now(), 'Import HILIA (revue)', 'import_review',
      jsonb_build_object('_unknown', true)
    from public.hilia_import_records r
    where r.id = any(p_ids)
      and r.kind = 'place'
      and r.existing_hilia_id is null
      and r.name is not null
    on conflict (id) do nothing;
    get diagnostics published = row_count;

    update public.hilia_import_records r
    set published_place_id = 'place_imp_' || substr(md5(r.id), 1, 20)
    where r.id = any(p_ids)
      and r.kind = 'place'
      and r.existing_hilia_id is null
      and r.published_place_id is null;
  end if;

  update public.hilia_import_records r
  set
    review_status = case p_decision
      when 'approve' then 'approved'
      when 'reject' then 'rejected'
      else 'review'
    end,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = p_note
  where r.id = any(p_ids)
    and r.kind in ('place', 'activity', 'route');

  select
    count(*) filter (where review_status = 'approved'),
    count(*) filter (where review_status = 'rejected'),
    count(*) filter (where review_status = 'review')
  into approved, rejected, needs_review
  from public.hilia_import_records
  where id = any(p_ids) and kind in ('place', 'activity', 'route');

  return jsonb_build_object(
    'approved', approved,
    'rejected', rejected,
    'needs_review', needs_review,
    'published_places', published,
    'note_published', 'Un lieu approuvé est créé dans hilia_places. Le catalogue statique ne le montre qu''après npm run data.'
  );
end;
$$;

revoke execute on function public.hilia_admin_review_decision(text[], text, text) from public, anon;
grant execute on function public.hilia_admin_review_decision(text[], text, text) to authenticated;

commit;
