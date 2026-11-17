# Environnement Supabase de test HILIA

Objectif : reproduire le **schéma public réel**, les contraintes et les RLS de
production dans un projet Supabase de test, puis y dérouler un petit import,
une approbation, des contrôles visiteur, une reprise et un rollback. Aucun
import massif et aucune écriture dans la production.

Ordre pratique : créer le projet, installer les outils PostgreSQL, créer le
fichier local de la section 4, produire le dump (section 2), l'inspecter
(section 2.1), puis seulement restaurer et décider des migrations (section 3).

> **Ne jamais coller une clé `service_role`, un mot de passe PostgreSQL ou une
> connection string dans la conversation.** Les valeurs restent dans un fichier
> local ignoré par Git.

## Première action

1. Créer un projet Supabase neuf, par exemple `hilia-test`, dans la région la
   plus proche. Garder le mot de passe de la base dans un gestionnaire de mots
   de passe.
2. Dans **Authentication → Users**, créer un utilisateur administrateur de test
   (adresse de test et mot de passe propres à ce projet).
3. Dans **Project Settings → API**, relever l'URL du projet, la clé
   `publishable` et la clé `service_role`.
4. Dans **Connect**, relever la connection string **Session pooler** (port
   5432), pas la Transaction pooler.

Configurer aussi **Authentication → URL Configuration** pour le test local :
Site URL `http://127.0.0.1:8788`, Redirect URLs `http://127.0.0.1:8788/**` et
`http://localhost:8788/**`. Sans cela, la connexion de l'administrateur de test
peut renvoyer vers une mauvaise adresse.

Le projet de test doit rester vide : on y restaure uniquement le schéma, jamais
les données de production.

## 1. Outils PostgreSQL

`pg_dump` et `psql` sont nécessaires. Une version portable de PostgreSQL 18.6
est installée dans le projet, dans `.tools/postgresql/pgsql/bin` (dossier ignoré
par Git). Le fichier `.env.hilia-test.local` ajoute ce dossier au `PATH`.

Charger l'environnement puis vérifier :

```bash
set -a
. ./.env.hilia-test.local
set +a
pg_dump --version
psql --version
```

La version de `pg_dump` doit être au moins égale à celle du serveur Supabase.
Docker et la CLI Supabase ne sont pas nécessaires pour cette étape. Si les
outils portables ont été supprimés, réinstaller les outils clients PostgreSQL
(par exemple l'installeur EDB en décochant le serveur) et remettre leur dossier
`bin` dans le `PATH`.

## 2. Capturer le schéma réel de production

Créer d'abord `.env.hilia-test.local` avec les deux connection strings (section
4) et charger les variables dans le terminal. Les commandes ci-dessous utilisent
`HILIA_PROD_DB_URL` pour le dump et `HILIA_TEST_DB_URL` pour l'inspection.

Créer le dossier local :

```bash
mkdir -p supabase/test
```

Avec la connection string de production dans une variable de shell (ne pas
l'écrire dans un fichier suivi par Git) :

```bash
export HILIA_PROD_DB_URL='postgresql://...'
pg_dump "$HILIA_PROD_DB_URL" \
  --schema-only \
  --schema=public \
  --no-owner \
  --no-comments \
  --file=supabase/test/production-schema.local.sql
```

Ne pas ajouter `--no-privileges` : les `GRANT` et les politiques RLS font
partie de ce qu'il faut reproduire. Le dump ne contient aucune ligne de
données.

Contrôles minimaux du fichier :

```bash
grep -c 'CREATE TABLE' supabase/test/production-schema.local.sql
grep -c 'ENABLE ROW LEVEL SECURITY' supabase/test/production-schema.local.sql
grep -c 'CREATE POLICY' supabase/test/production-schema.local.sql
grep -n 'hilia_places' supabase/test/production-schema.local.sql | head
```

Le fichier doit au minimum contenir `hilia_places`, ses contraintes, ses index,
ses privilèges et ses politiques. `hilia_import_records` et
`hilia_place_details` peuvent manquer si les migrations d'import n'ont pas
encore été appliquées en production : le noter, sans considérer le dump comme
invalide. C'est le schéma réel qui fait foi, pas les seules migrations du
dépôt : `hilia_places` et ses RLS ne sont pas versionnées.

### 2.1 Inspecter le dump avant toute restauration

Un projet Supabase neuf n'est pas un espace PostgreSQL vide : les schémas
`auth`, `storage`, `extensions`, les rôles `anon`, `authenticated` et
`service_role`, ainsi que plusieurs extensions, existent déjà. Il ne faut rien
supprimer pour faire de la place.

Charger d'abord les variables de la section 4, puis inspecter le dump :

```bash
DUMP=supabase/test/production-schema.local.sql

grep -nE '^(CREATE SCHEMA|CREATE EXTENSION|CREATE TABLE|CREATE POLICY|ALTER TABLE .* ENABLE ROW LEVEL SECURITY|CREATE (OR REPLACE )?FUNCTION|CREATE TRIGGER|GRANT |REVOKE |DROP |TRUNCATE|DELETE FROM|OWNER TO)' "$DUMP" | sed -n '1,160p'

# Objets qui indiquent quelles migrations sont déjà dans le dump.
grep -nE 'hilia_import_records|hilia_import_runs|hilia_place_details|publication_surface|hilia_admin_review_decision|hilia_json_number' "$DUMP" | sed -n '1,160p'
```

Points à contrôler avant de restaurer :

- Aucun `DROP`, `TRUNCATE` ou `DELETE FROM` au niveau supérieur du dump. Si
  l'un apparaît, ne pas exécuter le fichier : le dump doit être un
  `pg_dump --schema-only` ordinaire.
- Aucun `OWNER TO` : le dump est produit avec `--no-owner`.
- Un éventuel `CREATE SCHEMA public` est un conflit avec le schéma `public`
  déjà présent. Ne pas supprimer `public` ; traiter ce cas séparément.
- Les `CREATE EXTENSION` doivent correspondre à des extensions déjà présentes
  ou pouvoir être créées sans supprimer l'existant. Ne jamais faire
  `DROP EXTENSION` pour contourner un conflit.
- Les tables, fonctions et politiques doivent être dans `public`, pas dans
  `auth` ou `storage`.

Comparer avec les objets déjà présents dans le projet test :

```bash
psql "$HILIA_TEST_DB_URL" -Atc \
  "select table_schema||'.'||table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1;"

psql "$HILIA_TEST_DB_URL" -Atc \
  "select extname from pg_extension order by 1;"

psql "$HILIA_TEST_DB_URL" -Atc \
  "select rolname from pg_roles where rolname in ('anon','authenticated','service_role','postgres') order by 1;"

psql "$HILIA_TEST_DB_URL" -Atc \
  "select n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth') and p.proname in ('uid','hilia_is_admin','hilia_import_upsert','hilia_upsert_place_details','hilia_import_rollback','hilia_admin_review_decision','hilia_admin_review_queue') order by 1;"
```

Interprétation :

- Le projet test doit avoir les rôles `anon`, `authenticated` et
  `service_role`, et `auth.uid()` doit exister. Sinon, le projet n'est pas un
  projet Supabase standard : s'arrêter.
- Si une table `public.hilia_*` existe déjà dans le test, ne pas restaurer
  par-dessus. Comparer les colonnes et les politiques, puis décider objet par
  objet. Aucun `DROP SCHEMA public CASCADE` n'est autorisé dans cette
  procédure.
- Si le dump contient `CREATE SCHEMA public`, `CREATE EXTENSION` en conflit ou
  une table déjà présente, relever le nom exact et s'arrêter avant la
  restauration.

## 3. Restaurer dans le projet de test

Utiliser la connection string **Session pooler** du projet de test :

```bash
export HILIA_TEST_DB_URL='postgresql://...'
psql "$HILIA_TEST_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f supabase/test/production-schema.local.sql
```

Ne pas appliquer de migration tant que le dump n'a pas été inspecté et que les
conflits éventuels n'ont pas été traités.
Si la restauration échoue sur un objet déjà présent, la transaction est
annulée : ne pas relancer en supprimant les objets existants ; relever le nom
et le type de l'objet en conflit.

### 3.1 Vérifier les migrations déjà incluses

Le dump de production peut déjà contenir tout ou partie de `20261113`,
`20261114` et `20261116`. `20261117` peut aussi avoir été appliquée. Vérifier
les objets réels avant de choisir les fichiers à exécuter ; les migrations
`20261118` (moindre privilège) et `20261119` (timestamp exact du rollback)
complètent la séquence :

```bash
psql "$HILIA_TEST_DB_URL" -Atc \
  "select table_name||'.'||column_name from information_schema.columns where table_schema='public' and ((table_name='hilia_import_runs' and column_name in ('cursor','counts','status')) or (table_name='hilia_import_records' and column_name in ('auto_publishable','review_level','published_place_id','approval','publication_surface','published_at')) or (table_name='hilia_place_details' and column_name in ('import_run_id','is_public','description'))) order by 1;"

psql "$HILIA_TEST_DB_URL" -Atc \
  "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('hilia_import_upsert','hilia_upsert_place_details','hilia_import_rollback','hilia_is_admin','hilia_admin_review_queue','hilia_admin_review_decision','hilia_json_number') order by 1;"

psql "$HILIA_TEST_DB_URL" -Atc \
  "select has_function_privilege('anon','public.hilia_is_admin()','EXECUTE');"
```

Décision :

- `hilia_import_runs`, `hilia_import_records` et `hilia_place_details`
  absentes ensemble : le dump ne contient pas l'infrastructure d'import.
  Appliquer `20261113`, puis `20261114`, `20261116`, `20261117`, `20261118` et
  `20261119`, après avoir vérifié qu'aucune table existante ne porte ces noms.
- Seule une partie de ces tables existe : ne pas improviser. Comparer les
  colonnes et les dépendances, puis s'arrêter avant toute migration.
- `hilia_place_details` existe mais sans `is_public` ou `import_run_id` :
  `20261113` ne répare pas une table partiellement créée, car elle utilise
  `create table if not exists`. S'arrêter et comparer le schéma réel avant
  toute écriture.
- Tables présentes mais colonnes `auto_publishable`, `review_level` ou
  `published_place_id` absentes : `20261114` n'est pas incluse. Appliquer
  `20261114`, puis `20261116`, `20261117`, `20261118` et `20261119`.
- Colonnes `approval`, `publication_surface` ou `published_at` absentes, ou
  fonction `hilia_json_number` absente : appliquer `20261117`, puis `20261118`
  et `20261119`.
- `has_function_privilege('anon', …)` vaut `false` : appliquer `20261116`
  seule, puis vérifier les ACL avant d'appliquer `20261118`.
- Droits trop larges encore accordés à `anon`/`authenticated` (par exemple
  `UPDATE` sur `hilia_places`) : appliquer `20261118` après `20261117`.
- `hilia_import_rollback` contient encore `import_applied_at = coalesce(...)` :
  appliquer `20261119` après `20261118`.
- Tous les objets attendus sont présents : ne rien appliquer et passer à la
  vérification du schéma.

Les migrations ne doivent jamais être exécutées « en bloc » sans cette
comparaison. Ne pas réappliquer `20261113` ou `20261114` si leurs objets sont
déjà présents.

Puis vérifier le schéma et les RLS :

```bash
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_places"
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_import_records"
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_place_details"
psql "$HILIA_TEST_DB_URL" -c \
  "select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname='public' order by tablename, policyname;"
psql "$HILIA_TEST_DB_URL" -Atc \
  "select relname || ':' || relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname;"
```

## 4. Fichier d'environnement local

Créer `.env.hilia-test.local` à la racine du projet (déjà couvert par
`.gitignore`). Il ne doit jamais être commité :

```bash
# Ne pas mettre ces valeurs dans le chat ni dans un fichier versionné.
export HILIA_TEST_PROJECT_REF='<ref-du-projet-test>'
export SUPABASE_URL='https://<ref-du-projet-test>.supabase.co'
export SUPABASE_KEY='<clé publishable du projet test>'
export SUPABASE_SERVICE_ROLE_KEY='<clé service_role du projet test>'
export HILIA_TEST_DB_URL='postgresql://...session-pooler...'
export HILIA_PROD_DB_URL='postgresql://...' # uniquement pour le dump
```

Charger les variables dans Git Bash :

```bash
set -a
. ./.env.hilia-test.local
set +a
```

Contrôler la cible sans afficher de clé :

```bash
node -e "const u=new URL(process.env.SUPABASE_URL); if(u.hostname!==process.env.HILIA_TEST_PROJECT_REF+'.supabase.co'){console.error('MAUVAISE CIBLE');process.exit(1)} console.log('Cible :',u.hostname)"
```

Le garde-fou `HILIA_TEST_PROJECT_REF` fait échouer `push.mjs` et
`build-dataset.mjs` si `SUPABASE_URL` ne correspond pas exactement à
`<ref>.supabase.co`.

## 5. Administrateur de test

Créer l'utilisateur dans **Authentication → Users**, puis lui donner le rôle
admin. Vérifier d'abord la forme réelle de la table :

```bash
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_user_roles"
```

Puis, en adaptant les colonnes si le schéma réel diffère :

```sql
insert into public.hilia_user_roles (user_id, role)
select id, 'admin'
from auth.users
where email = 'admin-test@example.test'
on conflict (user_id) do update set role = 'admin';
```

L'utilisateur doit ensuite se connecter au site local avec son adresse et son
mot de passe. Le rôle admin ne se met pas dans le navigateur ni dans une
variable publique.

## 6. Les trois chemins doivent viser le même projet

Une fois les variables chargées dans le même terminal :

| Chemin | Variable utilisée | Vérification |
| --- | --- | --- |
| Import `push.mjs` | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | le plan affiche l'URL du projet test |
| `npm run data` | `SUPABASE_URL` + `SUPABASE_KEY` | `data/places.json` contient l'ID test |
| `npm run dev` + site | `SUPABASE_URL` + `SUPABASE_KEY`, injectés dans `/app.js` | la console affiche la cible test |

Ordre recommandé :

```bash
npm run import:push -- --source data/import-preview/validation.jsonl --batch 5
# Vérifier la cible affichée ; aucune écriture sans --execute.
```

Puis, seulement après l'approbation :

```bash
npm run data
PORT=8788 npm run dev
```

Le port **8788** est utilisé dans toute cette procédure, car 8787 est déjà
occupé sur cette machine. Il doit correspondre aux URL d'authentification du
projet test.

Ouvrir `http://127.0.0.1:8788` dans une fenêtre de navigation privée. Dans la
console du navigateur, vérifier la ligne
`HILIA : Supabase local ciblé sur …` et, dans l'onglet Réseau, que les requêtes
partent vers `<ref-test>.supabase.co`. Sans les variables, le serveur local
retombe sur les constantes de production : ne pas lancer `npm run dev` dans un
terminal qui n'a pas chargé `.env.hilia-test.local`.

## 7. Petit import, approbation et affichage visiteur

Le petit échantillon et l'approbation suivent `docs/INTEGRATION_DONNEES_HILIA.md`,
section « 4.3.1 Petit import de validation ». Générer d'abord
`data/import-preview/validation.jsonl` avec le script de cette section. Le point
de contrôle est le suivant :

1. L'import en plan montre la cible test et un petit nombre de fiches.
2. L'import avec `--execute` crée un `run_id` ; aucune ligne de production
   n'est touchée.
3. Dans le site local, l'administrateur connecté approuve un nouveau lieu dans
   **Mon profil → Administration → Nouveaux contenus importés**.
4. En navigation privée, sans session, la fiche approuvée apparaît avec ses
   détails complets (`hilia_place_details`).
5. La même fiche non approuvée n'apparaît pas dans le catalogue visiteur.

## 8. Contrôles RLS avec de vraies lignes

Un résultat vide sur un identifiant inventé ne prouve pas que la RLS protège
quelque chose. Il faut d'abord vérifier avec les droits serveur qu'une ligne
privée existe, puis interroger exactement cette ligne comme visiteur.

### 8.1 Choisir les identifiants réels de l'échantillon

Le `RUN_ID` est celui affiché par l'import. Sélectionner un lieu nouveau du run
et son détail préparé :

```bash
RUN_ID='<run_id>'

PRIVATE_RECORD_ID=$(psql "$HILIA_TEST_DB_URL" -Atc \
  "select r.id from public.hilia_import_records r join public.hilia_place_details d on d.place_id = 'place_imp_' || substr(md5(r.id),1,20) where r.last_seen_run='$RUN_ID' and r.kind='place' and r.existing_hilia_id is null order by r.id limit 1")

PRIVATE_PLACE_ID=$(psql "$HILIA_TEST_DB_URL" -Atc \
  "select 'place_imp_' || substr(md5('$PRIVATE_RECORD_ID'),1,20)")

: "${PRIVATE_RECORD_ID:?Aucun candidat réel trouvé pour ce run}"
: "${PRIVATE_PLACE_ID:?Identifiant de détail réel introuvable}"

echo "record=$PRIVATE_RECORD_ID place=$PRIVATE_PLACE_ID"
```

Vérifier que ces lignes existent réellement avec les droits serveur :

```bash
psql "$HILIA_TEST_DB_URL" -c \
  "select id, kind, review_status, published_place_id from public.hilia_import_records where id='$PRIVATE_RECORD_ID';"

psql "$HILIA_TEST_DB_URL" -c \
  "select place_id, is_public, description from public.hilia_place_details where place_id='$PRIVATE_PLACE_ID';"

psql "$HILIA_TEST_DB_URL" -c \
  "select id, status from public.hilia_places where id='$PRIVATE_PLACE_ID';"
```

Avant l'approbation, le détail doit exister avec `is_public = false`, et
`hilia_places` ne doit pas encore contenir cet identifiant. Si le détail ou le
lieu attendu n'existe pas, choisir un autre candidat réel ; ne pas fabriquer
d'identifiant.

### 8.2 En-têtes selon le type de clé

Une clé `sb_publishable_…` s'envoie dans `apikey`. Ce n'est pas nécessairement
un JWT : ne pas ajouter `Authorization: Bearer` avec cette forme.

Le helper `lib/supabase-key.js` applique cette règle à `lib/place.js`,
`push.mjs` et `build-dataset.mjs`. Les requêtes ci-dessous la reproduisent pour
les contrôles manuels.

```bash
case "$SUPABASE_KEY" in
  sb_secret_*)
    echo "Clé secrète interdite pour ce test navigateur."; exit 1 ;;
esac

API_HEADERS=(-H "apikey: $SUPABASE_KEY")
if [[ "$SUPABASE_KEY" != sb_publishable_* ]]; then
  # Ancienne clé anon au format JWT uniquement.
  API_HEADERS+=(-H "Authorization: Bearer $SUPABASE_KEY")
fi
```

Les vérifications de lignes privées ci-dessus utilisent `psql` et les droits
serveur. Ne jamais utiliser la clé `service_role` dans le navigateur ni dans
une requête RLS « visiteur ».

### 8.3 Vérifier la ligne privée comme visiteur

```bash
# La ligne de staging exacte existe, mais la table est révoquée : 401/403.
curl -sS -o /dev/null -w 'staging exact: %{http_code}\n' -G \
  "$SUPABASE_URL/rest/v1/hilia_import_records" \
  "${API_HEADERS[@]}" \
  --data-urlencode 'select=id' \
  --data-urlencode "id=eq.$PRIVATE_RECORD_ID"
```

```bash
# Le détail privé exact existe, mais la RLS le masque : 200 avec [].
curl -sS -w '\ndetail privé: %{http_code}\n' -G \
  "$SUPABASE_URL/rest/v1/hilia_place_details" \
  "${API_HEADERS[@]}" \
  --data-urlencode 'select=place_id,is_public' \
  --data-urlencode "place_id=eq.$PRIVATE_PLACE_ID"
```

Résultat attendu : la première requête ne renvoie aucune ligne (401/403), la
seconde renvoie `[]` en 200. Si la seconde renvoie la ligne privée, la RLS est
en échec.

Si la seconde réponse est `400` pour une colonne inconnue, ne pas conclure :
le schéma de `hilia_place_details` diffère de celui attendu, vérifier ses
colonnes réelles avant de poursuivre.

### 8.4 Vérifier qu'un visiteur ne peut pas approuver

```bash
curl -sS -o /dev/null -w 'approbation anonyme: %{http_code}\n' \
  -X POST "$SUPABASE_URL/rest/v1/rpc/hilia_admin_review_decision" \
  "${API_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"p_ids\":[\"$PRIVATE_RECORD_ID\"],\"p_decision\":\"approve\"}"
```

Attendu : 401 ou 403, et aucune modification de `review_status`. Vérifier
ensuite avec `psql` que la ligne est toujours non approuvée.

### 8.5 Après approbation

Une fois le lieu approuvé dans l'interface admin, réutiliser exactement le même
`PRIVATE_PLACE_ID` :

```bash
APPROVED_ID="$PRIVATE_PLACE_ID"
psql "$HILIA_TEST_DB_URL" -c \
  "select id, status from public.hilia_places where id='$APPROVED_ID';"

curl -sS -G \
  "$SUPABASE_URL/rest/v1/hilia_place_details" \
  "${API_HEADERS[@]}" \
  --data-urlencode 'select=*' \
  --data-urlencode "place_id=eq.$APPROVED_ID"
```

Attendu : une ligne `hilia_places` avec `status = approved`, et un détail
public complet. Un `200` vide après approbation est un échec de transfert ou de
RLS, pas une preuve d'absence.

Un `200` sur le staging ou sur l'approbation anonyme est un échec : arrêter et
signaler la politique concernée avant de continuer.

## 9. Reprise après interruption

Lancer un import par petits lots :

```bash
npm run import:push -- --source data/import-preview/validation.jsonl --batch 1 --execute
```

Après le premier lot, interrompre avec `Ctrl+C` (ou arrêter le processus depuis
le gestionnaire de tâches). Noter le `run_id` affiché. Reprendre :

```bash
npm run import:push -- --source data/import-preview/validation.jsonl --batch 1 --execute --resume --run-id '<run_id>'
```

Vérifier dans le staging que le curseur a avancé et qu'aucun lot n'a été
dupliqué. La reprise ne doit ni recréer le run ni repartir de zéro.

## 10. Rollback

Le rollback s'applique au run de test, jamais à une fiche approuvée :

```bash
npm run import:push -- --rollback '<run_id>' --execute
```

Vérifier :

- les lignes de staging du run sont supprimées ;
- les détails créés par le run sont retirés ;
- un détail préexistant qui avait été enrichi est restauré ;
- la fiche déjà approuvée reste dans `hilia_places` (le rollback ne la supprime
  pas).

Si le lieu approuvé doit disparaître du site, ce n'est pas un rollback : voir
la section suivante.

## 11. Retrait de publication distinct

Le retrait se fait toujours par le statut de la fiche et la visibilité du
détail, sans supprimer la ligne et sans utiliser `hilia_places.is_public` :

```sql
begin;
update public.hilia_places
set status = 'rejected'
where id = '<APPROVED_ID>'
returning id, status;
update public.hilia_place_details
set is_public = false
where place_id = '<APPROVED_ID>';
commit;
```

Utiliser exactement l'`APPROVED_ID` vérifié à la section 8.5. `status =
'rejected'` retire la fiche du catalogue ; `is_public = false` masque son
détail enrichi. Ne pas supprimer la ligne : elle conserve la trace de l'import
et de la décision.

Puis régénérer le catalogue statique **sur l'environnement de test** :

```bash
npm run data
```

Vérifier que l'ID n'est plus dans `data/places.json` et que le détail n'est plus
lisible en visiteur. Ne pas déployer ce fichier : c'est une vérification
locale. La ligne reste dans la table pour la traçabilité.

## 12. Résultat attendu

À consigner à la fin :

- dump inspecté, conflits et dépendances : OK / erreur ;
- migrations déjà incluses et migrations appliquées : liste ;
- dump et restauration : OK / erreur ;
- RLS staging : 401/403 ;
- ligne privée réelle vérifiée avec les droits serveur, puis `[]` en visiteur ;
- détail approuvé : une ligne complète pour le même identifiant ;
- approbation anonyme : 401/403 et statut inchangé ;
- affichage visiteur sans session : OK / échec ;
- reprise : curseur et comptes cohérents ;
- rollback : staging et détails nettoyés, fiche approuvée conservée ;
- retrait : `status='rejected'` dans `hilia_places` et `is_public=false` dans
  `hilia_place_details` ; fiche absente du catalogue et détail masqué ;
- aucune écriture en production.
