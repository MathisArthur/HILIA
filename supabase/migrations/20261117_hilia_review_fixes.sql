-- HILIA - correctifs de revue et d'approbation.
--
-- À exécuter APRÈS 20261114_hilia_review.sql, y compris sur une base où les
-- migrations précédentes sont déjà appliquées. Cette migration est idempotente.
--
-- Elle corrige :
--   * la lecture des catégories (chaînes JSONL, pas des objets {name}) ;
--   * la lecture du site, des coordonnées et des champs normalisés ;
--   * le transfert de l'enrichissement préparé pour un nouveau lieu ;
--   * le statut de publication réel des activités et itinéraires ;
--   * la condition sur un tableau d'identifiants vide.

begin;

-- ---------------------------------------------------------------------------
-- Champs de normalisation et de publication
-- ---------------------------------------------------------------------------
alter table public.hilia_import_records
  add column if not exists approval jsonb,
  add column if not exists publication_surface text,
  add column if not exists published_at timestamptz;

comment on column public.hilia_import_records.approval is
  'Champs normalisés et enrichissement préparés par push.mjs pour l’approbation. Le payload brut reste dans payload.';
comment on column public.hilia_import_records.publication_surface is
  'Surface publique réelle : hilia_places, staging_only, ou NULL si aucune publication.';
comment on column public.hilia_import_records.published_at is
  'Date de création de la fiche publique. NULL pour une activité ou un itinéraire seulement validé en staging.';

-- Évite qu’une chaîne ou un JSON invalide fasse échouer toute une approbation.
create or replace function public.hilia_json_number(p_value jsonb)
returns double precision
language plpgsql
immutable
as $$
declare
  raw text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) = 'number' then
    return (p_value #>> '{}')::double precision;
  end if;
  if jsonb_typeof(p_value) = 'string' then
    raw := btrim(p_value #>> '{}');
    if raw ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' then
      return raw::double precision;
    end if;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

revoke execute on function public.hilia_json_number(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Staging : conserver le bloc d'approbation normalisé
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
      review_reasons jsonb, payload jsonb, approval jsonb
    )
  ), upserted as (
    insert into public.hilia_import_records (
      id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, review_status, auto_publishable, review_level,
      review_reasons, payload, approval, first_seen_run, last_seen_run
    )
    select id, kind, source, source_id, existing_hilia_id, name, commune, postal_code,
      publication_status, coalesce(review_status, 'pending'),
      coalesce(auto_publishable, false), coalesce(review_level, 'manual'),
      coalesce(review_reasons, '[]'::jsonb), payload, approval, p_run_id, p_run_id
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
      approval = coalesce(excluded.approval, hilia_import_records.approval),
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
-- Approbation : identité, site, coordonnées, catégorie et enrichissement
-- ---------------------------------------------------------------------------
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
  staged_activities integer := 0;
  staged_routes integer := 0;
begin
  if not public.hilia_is_admin() then
    raise exception using errcode = '42501', message = 'Administration requise';
  end if;
  if p_decision not in ('approve', 'reject', 'needs_review') then
    raise exception 'Décision inconnue : %', p_decision;
  end if;
  -- array_length() renvoie un entier, pas un booléen : on le compare à zéro.
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'approved', 0,
      'rejected', 0,
      'needs_review', 0,
      'published_places', 0,
      'approved_activities_staged', 0,
      'approved_routes_staged', 0,
      'note_published', 'Aucun identifiant fourni : aucune décision enregistrée.'
    );
  end if;

  if p_decision = 'approve' then
    with candidates as (
      select
        r.id,
        'place_imp_' || substr(md5(r.id), 1, 20) as place_id,
        r.name,
        r.approval,
        r.payload
      from public.hilia_import_records r
      where r.id = any(p_ids)
        and r.kind = 'place'
        and r.existing_hilia_id is null
        and coalesce(nullif(r.name, ''), nullif(r.approval->>'name', '')) is not null
    ), inserted as (
      insert into public.hilia_places (
        id, name, activity, address, cp, commune, site, lat, lon,
        status, approved_at, author_name, data_origin, access
      )
      select
        c.place_id,
        coalesce(nullif(c.approval->>'name', ''), nullif(c.name, '')),
        coalesce(
          nullif(c.approval->>'activity', ''),
          case
            when jsonb_typeof(c.payload->'categories') = 'array'
              and jsonb_array_length(c.payload->'categories') > 0
            then case
              when jsonb_typeof(c.payload->'categories'->0) = 'object'
                then c.payload->'categories'->0->>'name'
              else c.payload->'categories'->>0
            end
          end,
          'Sports et loisirs'
        ),
        coalesce(nullif(c.approval->>'address', ''), c.payload->>'address', ''),
        coalesce(nullif(c.approval->>'postal_code', ''), c.payload->>'postal_code', ''),
        coalesce(nullif(c.approval->>'commune', ''), c.payload->>'commune', ''),
        coalesce(
          nullif(c.approval->>'site', ''),
          nullif(c.payload->'websites'->>0, ''),
          nullif(c.payload->'contacts'->'websites'->>0, '')
        ),
        public.hilia_json_number(coalesce(c.approval->'latitude', c.payload->'coordinates'->'latitude')),
        public.hilia_json_number(coalesce(c.approval->'longitude', c.payload->'coordinates'->'longitude')),
        'approved', now(), 'Import HILIA (revue)', 'import_review',
        coalesce(c.approval->'access', jsonb_build_object('_unknown', true))
      from candidates c
      on conflict (id) do nothing
      returning id
    )
    select count(*) into published from inserted;

    -- Le détail a été préparé par push.mjs sous le futur identifiant public.
    -- Il est transféré ici, puis rendu public avec la fiche. Les absences
    -- restent explicitement inconnues.
    with candidates as (
      select
        r.id,
        'place_imp_' || substr(md5(r.id), 1, 20) as place_id,
        r.approval,
        r.payload,
        coalesce(r.approval->'detail', '{}'::jsonb) as detail
      from public.hilia_import_records r
      where r.id = any(p_ids)
        and r.kind = 'place'
        and r.existing_hilia_id is null
        and coalesce(nullif(r.name, ''), nullif(r.approval->>'name', '')) is not null
    )
    insert into public.hilia_place_details (
      place_id, description, description_source, categories, media, hours,
      prices, contacts, accessibility, source_refs, licence_partition,
      is_public, import_run_id, import_applied_at
    )
    select
      c.place_id,
      nullif(coalesce(c.detail->>'description', c.payload->>'description'), ''),
      c.detail->'descriptionSource',
      coalesce(c.detail->'categories', '[]'::jsonb),
      coalesce(c.detail->'media', '[]'::jsonb),
      coalesce(c.detail->'hours', '[]'::jsonb),
      c.detail->'prices',
      c.detail->'contacts',
      coalesce(c.detail->'accessibility', jsonb_build_object('_unknown', true)),
      coalesce(c.detail->'sourceRefs', '[]'::jsonb),
      coalesce(
        (select array_agg(value)
         from jsonb_array_elements_text(coalesce(c.detail->'licencePartition', '[]'::jsonb)) value),
        '{}'::text[]
      ),
      true,
      null,
      now()
    from candidates c
    on conflict (place_id) do update set
      description = coalesce(excluded.description, hilia_place_details.description),
      description_source = coalesce(excluded.description_source, hilia_place_details.description_source),
      categories = case when excluded.categories = '[]'::jsonb then hilia_place_details.categories else excluded.categories end,
      media = case when excluded.media = '[]'::jsonb then hilia_place_details.media else excluded.media end,
      hours = case when excluded.hours = '[]'::jsonb then hilia_place_details.hours else excluded.hours end,
      prices = coalesce(excluded.prices, hilia_place_details.prices),
      contacts = coalesce(excluded.contacts, hilia_place_details.contacts),
      accessibility = case
        when coalesce((excluded.accessibility->>'_unknown')::boolean, false)
          then coalesce(hilia_place_details.accessibility, excluded.accessibility)
        else excluded.accessibility
      end,
      source_refs = case when excluded.source_refs = '[]'::jsonb then hilia_place_details.source_refs else excluded.source_refs end,
      licence_partition = case when excluded.licence_partition = '{}'::text[] then hilia_place_details.licence_partition else excluded.licence_partition end,
      is_public = true,
      updated_at = now();

    -- Rattache les identifiants publiés au staging, même si la fiche existait
    -- déjà (approbation répétée) ou si l'insertion a été ignorée.
    update public.hilia_import_records r
    set
      published_place_id = c.place_id,
      published_at = coalesce(r.published_at, now()),
      publication_surface = 'hilia_places'
    from (
      select r2.id, 'place_imp_' || substr(md5(r2.id), 1, 20) as place_id
      from public.hilia_import_records r2
      where r2.id = any(p_ids)
        and r2.kind = 'place'
        and r2.existing_hilia_id is null
        and coalesce(nullif(r2.name, ''), nullif(r2.approval->>'name', '')) is not null
    ) c
    where r.id = c.id;
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
    review_note = p_note,
    publication_surface = case
      when p_decision = 'approve' and r.kind = 'place' and r.published_place_id is not null then 'hilia_places'
      when p_decision = 'approve' and r.kind in ('activity', 'route') then 'staging_only'
      else null
    end,
    published_at = case
      when p_decision = 'approve' and r.kind = 'place' and r.published_place_id is not null then coalesce(r.published_at, now())
      else null
    end
  where r.id = any(p_ids)
    and r.kind in ('place', 'activity', 'route');

  select
    count(*) filter (where review_status = 'approved'),
    count(*) filter (where review_status = 'rejected'),
    count(*) filter (where review_status = 'review')
  into approved, rejected, needs_review
  from public.hilia_import_records
  where id = any(p_ids) and kind in ('place', 'activity', 'route');

  select
    count(*) filter (where kind = 'activity' and review_status = 'approved'),
    count(*) filter (where kind = 'route' and review_status = 'approved')
  into staged_activities, staged_routes
  from public.hilia_import_records
  where id = any(p_ids) and kind in ('activity', 'route');

  return jsonb_build_object(
    'approved', approved,
    'rejected', rejected,
    'needs_review', needs_review,
    'published_places', published,
    'approved_activities_staged', staged_activities,
    'approved_routes_staged', staged_routes,
    'note_published',
      'Un lieu approuvé est créé ou conservé dans hilia_places, avec son enrichissement et son accessibilité inconnue si absente. Les activités et itinéraires approuvés sont seulement validés en staging : aucune surface publique ne les affiche encore.'
  );
end;
$$;

revoke execute on function public.hilia_admin_review_decision(text[], text, text) from public, anon;
grant execute on function public.hilia_admin_review_decision(text[], text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- File de revue : exposer l'état réel de publication
-- ---------------------------------------------------------------------------
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
      r.publication_surface, r.published_at,
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

-- ---------------------------------------------------------------------------
-- Rollback : corrige aussi le cast uuid de l'ancienne version
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
      import_run_id = case when h.previous_row is null then null else (h.previous_row->>'import_run_id')::uuid end,
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

commit;
