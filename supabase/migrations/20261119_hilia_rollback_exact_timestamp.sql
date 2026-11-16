-- HILIA - restauration exacte de import_applied_at lors du rollback.
--
-- La valeur historique doit être recopiée telle quelle, y compris NULL :
-- l'ancienne version utilisait coalesce(..., now()) et inventait donc une date
-- pour un détail qui n'avait jamais été appliqué.
begin;

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
      import_applied_at = (h.previous_row->>'import_applied_at')::timestamptz,
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
