-- ---------------------------------------------------------------------------
-- Lecture publique : hilia_is_admin doit rester exécutable par anon
-- ---------------------------------------------------------------------------
-- La migration 20261114 a révoqué EXECUTE sur hilia_is_admin() pour anon.
-- Or les politiques RLS de hilia_places et hilia_place_details appellent cette
-- fonction pour distinguer un visiteur d'un administrateur. PostgreSQL refuse
-- alors la requête entière avec « permission denied for function
-- hilia_is_admin » (HTTP 401), au lieu de considérer le visiteur comme non
-- administrateur. Les pages statiques restent servies, mais les fiches et les
-- détails lus depuis Supabase deviennent inaccessibles.
--
-- La fonction est stable, SECURITY DEFINER, limitée à la lecture de
-- hilia_user_roles et protégée par un search_path fixe. Pour un visiteur
-- anonyme, auth.uid() est NULL : elle renvoie false sans exposer de données.
begin;

grant execute on function public.hilia_is_admin() to anon;

commit;
