-- HILIA - réduction des privilèges publics.
--
-- Migration destinée à être appliquée après 20261117. Elle conserve :
--   * la lecture publique des contenus publiés ;
--   * les écritures autorisées par les politiques RLS pour authenticated ;
--   * l'envoi public d'une soumission de prestataire ;
--   * le rôle service_role pour l'import et les traitements serveur.
--
-- Les tables d'import, l'historique des détails et les séquences ne sont plus
-- accessibles à anon ni à authenticated. Les fonctions d'import et d'écriture
-- interne restent réservées à service_role.
--
-- Les privilèges par défaut du rôle plateforme supabase_admin ne peuvent pas
-- être modifiés par le rôle postgres ; seuls ceux de postgres sont corrigés ici.

begin;

-- ---------------------------------------------------------------------------
-- 1. Retirer les droits de table et de séquence trop larges
-- ---------------------------------------------------------------------------
revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

-- service_role reste le rôle serveur de confiance pour l'import.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 2. Lecture publique des contenus du site
-- ---------------------------------------------------------------------------
grant select on table
  public.hilia_places,
  public.hilia_place_details,
  public.hilia_place_edits,
  public.hilia_activities,
  public.hilia_reviews,
  public.hilia_base_places,
  public.hilia_events,
  public.hilia_leisure_activities,
  public.hilia_routes,
  public.hilia_media
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Écritures autorisées par les politiques RLS
-- ---------------------------------------------------------------------------
-- Fiches : sélection publique ci-dessus ; création et gestion par les rôles
-- autorisés dans les politiques places_insert / places_update_admin /
-- places_delete_admin.
grant insert, update, delete on table public.hilia_places to authenticated;

-- Avis : lecture publique ci-dessus ; les politiques limitent les écritures
-- à l'auteur connecté.
grant insert, update, delete on table public.hilia_reviews to authenticated;

-- Contributions et modifications de fiches : les politiques vérifient le rôle
-- administrateur ou l'auteur.
grant insert, update, delete on table public.hilia_place_edits to authenticated;

-- Suggestions : envoi et consultation par un utilisateur connecté, avec les
-- contrôles d'accès des politiques.
grant select, insert, update on table public.hilia_suggestions to authenticated;

-- Rôles applicatifs : un utilisateur ne peut lire que son propre rôle.
grant select on table public.hilia_user_roles to authenticated;

-- Soumissions prestataires : envoi public possible, lecture et décision
-- réservées aux administrateurs par RLS.
grant insert on table public.hilia_provider_submissions to anon, authenticated;
grant select, update on table public.hilia_provider_submissions to authenticated;

-- Catégories d'activités : lecture publique ; ajout réservé aux admins.
grant insert on table public.hilia_activities to authenticated;

-- Référentiel de base : lecture publique ; mise à jour réservée aux admins.
grant update on table public.hilia_base_places to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Fonctions : aucune fonction interne exécutable par anon/authenticated
-- ---------------------------------------------------------------------------
revoke all privileges on all functions in schema public from public, anon, authenticated;

-- Nécessaire aux politiques RLS de lecture, y compris pour anon.
grant execute on function public.hilia_is_admin() to anon, authenticated, service_role;

-- Nécessaire à la politique d'insertion d'une fiche par un utilisateur certifié.
grant execute on function public.hilia_is_certified() to authenticated, service_role;

-- Outils de revue réservés aux utilisateurs connectés ; la fonction vérifie
-- elle-même hilia_is_admin().
grant execute on function public.hilia_admin_review_queue(text, text, integer, integer)
  to authenticated, service_role;
grant execute on function public.hilia_admin_review_decision(text[], text, text)
  to authenticated, service_role;

-- Import, rollback, normalisation et triggers restent réservés au serveur.
grant execute on all functions in schema public to service_role;

grant usage on schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Privilèges par défaut pour les futurs objets créés par postgres
-- ---------------------------------------------------------------------------
-- Aucun nouveau tableau, séquence ou fonction ne doit être automatiquement
-- exposé à anon/authenticated. Les droits seront accordés explicitement.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public;

commit;
