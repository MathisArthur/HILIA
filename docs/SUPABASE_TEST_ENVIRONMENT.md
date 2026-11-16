# Environnement Supabase de test HILIA

Objectif : reproduire le **schéma public réel**, les contraintes et les RLS de
production dans un projet Supabase de test, puis y dérouler un petit import,
une approbation, des contrôles visiteur, une reprise et un rollback. Aucun
import massif et aucune écriture dans la production.

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
Site URL `http://127.0.0.1:8787`, Redirect URLs `http://127.0.0.1:8787/**` et
`http://localhost:8787/**`. Sans cela, la connexion de l'administrateur de test
peut renvoyer vers une mauvaise adresse.

Le projet de test doit rester vide : on y restaure uniquement le schéma, jamais
les données de production.

## 1. Outils PostgreSQL

`pg_dump` et `psql` sont nécessaires. Ils ne sont pas installés sur cette
machine. Installer les **outils clients PostgreSQL** (par exemple l'installeur
EDB en décochant le serveur), puis vérifier dans Git Bash :

```bash
pg_dump --version
psql --version
```

La version de `pg_dump` doit être au moins égale à celle du serveur Supabase.
Docker et la CLI Supabase ne sont pas nécessaires pour cette étape.

## 2. Capturer le schéma réel de production

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

Le fichier doit contenir `hilia_places`, `hilia_import_records`,
`hilia_place_details`, les contraintes, les index, les privilèges et les
politiques. C'est le schéma réel qui fait foi, pas les seules migrations du
dépôt : `hilia_places` et ses RLS ne sont pas versionnées.

## 3. Restaurer dans le projet de test

Utiliser la connection string **Session pooler** du projet de test :

```bash
export HILIA_TEST_DB_URL='postgresql://...'
psql "$HILIA_TEST_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/test/production-schema.local.sql
```

Puis appliquer la migration corrective de la branche :

```bash
psql "$HILIA_TEST_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20261117_hilia_review_fixes.sql
```

Vérifier le schéma et les RLS :

```bash
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_places"
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_import_records"
psql "$HILIA_TEST_DB_URL" -c "\d+ public.hilia_place_details"
psql "$HILIA_TEST_DB_URL" -c \
  "select schemaname, tablename, policyname, cmd, roles from pg_policies where schemaname='public' order by tablename, policyname;"
psql "$HILIA_TEST_DB_URL" -Atc \
  "select relname || ':' || relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by relname;"
```

Vérifier les colonnes ajoutées par la migration corrective :

```bash
psql "$HILIA_TEST_DB_URL" -Atc \
  "select column_name from information_schema.columns where table_schema='public' and table_name='hilia_import_records' and column_name in ('cursor_index','total_records','processed_records','failed_records');"
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
npm run dev
```

Si le port 8787 est déjà utilisé, lancer `PORT=8788 npm run dev` et ouvrir
`http://127.0.0.1:8788`. Le port est indépendant de la cible Supabase.

Ouvrir `http://127.0.0.1:8787` dans une fenêtre de navigation privée. Dans la
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

## 8. Contrôles RLS visiteur

Exécuter ces requêtes avec la clé **publishable** uniquement ; elles ne doivent
rien écrire.

```bash
# Données de staging privées : attendu 401 ou 403.
curl -sS -o /dev/null -w 'staging: %{http_code}\n' \
  "$SUPABASE_URL/rest/v1/hilia_import_records?select=id&limit=1" \
  -H "apikey: $SUPABASE_KEY"
```

```bash
# Détail d'un lieu non approuvé : attendu 200 avec [].
PRIVATE_ID='place_imp_a_confirmer'
curl -sS -o /dev/null -w 'detail privé: %{http_code}\n' \
  "$SUPABASE_URL/rest/v1/hilia_place_details?select=place_id&place_id=eq.$PRIVATE_ID" \
  -H "apikey: $SUPABASE_KEY"
```

```bash
# Détail du lieu approuvé : attendu 200 avec une ligne complète.
APPROVED_ID='place_imp_approuve'
curl -sS \
  "$SUPABASE_URL/rest/v1/hilia_place_details?select=*&place_id=eq.$APPROVED_ID" \
  -H "apikey: $SUPABASE_KEY"
```

```bash
# Tentative d'approbation sans session admin : attendu 401 ou 403.
curl -sS -o /dev/null -w 'approbation anonyme: %{http_code}\n' \
  -X POST "$SUPABASE_URL/rest/v1/rpc/hilia_admin_review_decision" \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"p_ids":["place_imp_a_confirmer"],"p_decision":"approve"}'
```

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

Pour retirer un lieu déjà approuvé sans le supprimer :

```sql
update public.hilia_places
set status = 'rejected', is_public = false
where id = 'place_imp_approuve';
```

```sql
update public.hilia_place_details
set is_public = false
where place_id = 'place_imp_approuve';
```

Puis régénérer le catalogue statique **sur l'environnement de test** :

```bash
npm run data
```

Vérifier que l'ID n'est plus dans `data/places.json` et que le détail n'est plus
lisible en visiteur. Ne pas déployer ce fichier : c'est une vérification
locale. La ligne reste dans la table pour la traçabilité.

## 12. Résultat attendu

À consigner à la fin :

- dump et restauration : OK / erreur ;
- RLS staging : 401/403 ;
- détail privé : `[]` ;
- détail approuvé : une ligne complète ;
- approbation anonyme : 401/403 ;
- affichage visiteur sans session : OK / échec ;
- reprise : curseur et comptes cohérents ;
- rollback : staging et détails nettoyés, fiche approuvée conservée ;
- retrait : fiche absente du catalogue et détail masqué ;
- aucune écriture en production.
