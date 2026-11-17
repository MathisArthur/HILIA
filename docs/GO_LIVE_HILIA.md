# Passage en production HILIA

Ce document prépare le passage en production de l'import enrichi HILIA. Il ne
remplace pas une sauvegarde récente : aucune migration ni aucun import ne doit
être lancé avant les contrôles ci-dessous.

## 1. État constaté le 16 novembre 2026

Contrôles effectués en lecture seule sur le projet de production, et sur le
projet `hilia-test` pour les essais :

- État initial du 16 novembre : **54 350** fiches `hilia_places`, toutes
  `approved`, et **0** ligne dans `hilia_place_details`.
- Après le premier lot, au 17 novembre : **54 351** fiches `hilia_places`, toutes
  `approved`, **4** détails dont **2** publics (Le Klube et Ecozonia). L'écart
  avec le catalogue de 54 350 vient de `29088`, approuvée en base mais exclue du
  catalogue et des détails ; Ecozonia est déjà approuvée. Les **8**
  enregistrements d'import sont présents.
- État initial : **0** run, **0** enregistrement et **0** lot d'import. La base
  complète pèse environ **38 Mo**.
- Le catalogue national versionné contient **54 349** fiches. L'écart d'une
  fiche correspond au retrait qualité `29088`, déjà tracé dans
  `data/place-exclusions.json`.
- Les migrations `20261113_hilia_import.sql`,
  `20261114_hilia_review.sql` et
  `20261116_hilia_restore_public_read.sql` sont présentes en production.
- Les migrations **`20261117_hilia_review_fixes.sql`**,
  **`20261118_hilia_least_privilege.sql`** et
  **`20261119_hilia_rollback_exact_timestamp.sql`** sont **absentes** :
  - `hilia_import_records` n'a pas `approval`, `publication_surface` ni
    `published_at` ;
  - `hilia_json_number` et les correctifs d'approbation ne sont pas actifs ;
  - `anon` et `authenticated` ont encore des droits trop larges sur
    `hilia_places` et `hilia_user_roles` ;
  - `hilia_import_rollback` utilise encore `coalesce(..., now())` pour
    `import_applied_at`.
- Le test `hilia-test` a validé une fiche sans média (**Le Puits salé**) et une
  fiche avec médias (**Ecozonia**) : approbation, lecture anonyme,
  `/api/media`, quatre images chargées et crédits conservés.
- Le catalogue et les sitemaps de production ont été restaurés depuis
  `.tools/catalog-before/` après les essais. Les versions restaurées sont
  identiques à la sauvegarde ; aucun `place_imp_` de test n'y figure.

Ne pas déduire de cet état qu'un import massif peut être lancé directement :
le premier lot et les contrôles de publication restent obligatoires.

## 2. Préflight et sauvegarde

### 2.1 Vérifier la cible

Travailler avec le fichier local ignoré `.env.hilia-test.local`, sans jamais
coller une clé, un mot de passe ou une connection string dans un ticket ou un
commit. Avant toute commande d'écriture, vérifier que `SUPABASE_URL` désigne
bien la production et que `HILIA_TEST_PROJECT_REF` n'est pas exporté :

```bash
set -a
. ./.env.hilia-test.local
set +a
unset HILIA_TEST_PROJECT_REF
node -e "const h=new URL(process.env.SUPABASE_URL).hostname; if(h!=='lokplzdkvzilsuuqflsk.supabase.co') { console.error('cible inattendue: '+h); process.exit(1); } console.log('cible production: '+h)"
```

Vérifier aussi que la branche et le catalogue sont propres :

```bash
git status --short
git diff --exit-code -- data/places.json sitemap.xml sitemap-lieux-1.xml sitemap-lieux-2.xml sitemap-pages.xml
```

### 2.2 Créer une sauvegarde avant toute écriture

La sauvegarde complète et un dump du schéma public ont été produits localement
le 16 novembre 2026 dans `.tools/prod-backup/` (dossier ignoré). Le dump complet
contient les schémas Supabase `public`, `auth`, `storage`, etc. ; il ne doit
jamais être ajouté au dépôt.

```bash
mkdir -p .tools/prod-backup
STAMP=$(date +%Y%m%dT%H%M%S)
pg_dump "$HILIA_PROD_DB_URL" \
  --format=custom --no-owner \
  --file=".tools/prod-backup/hilia-prod-$STAMP.dump"
pg_dump "$HILIA_PROD_DB_URL" \
  --schema-only --schema=public --no-owner \
  --file=".tools/prod-backup/hilia-public-schema-$STAMP.sql"
sha256sum .tools/prod-backup/*
pg_restore --list ".tools/prod-backup/hilia-prod-$STAMP.dump" | sed -n '1,40p'
```

Contrôles attendus : le dump est lisible par `pg_restore`, il contient les
tables HILIA, et la taille est cohérente avec la base (environ 6 Mo pour le dump
comprimé au 16 novembre 2026). Conserver une copie hors de la machine, dans le
stockage chiffré de l'équipe, et vérifier la rétention des sauvegardes
automatiques Supabase (PITR) avant de migrer.

La sauvegarde ne doit pas être confondue avec les fichiers de test :
`data/import-preview/validation.jsonl`, `.tools/catalog-before/`, les dumps et
`.env.hilia-test.local` restent hors Git.

### 2.3 Procédure de restauration

**Règle absolue : ne jamais restaurer un dump par-dessus la production
existante.** Une restauration s'effectue dans un projet Supabase neuf ou une
base jetable, puis on bascule l'application après validation.

- Pour un désastre complet (auth, storage, données), préférer la restauration
  Supabase/PITR vers un nouveau projet, avec le dump comme seconde source.
- Pour restaurer uniquement le schéma public dans un projet neuf :

```bash
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f .tools/prod-backup/hilia-public-schema-<timestamp>.sql
```

- Pour restaurer uniquement les données HILIA dans un projet dont le schéma a
  déjà été préparé par les migrations (base vide, jamais la production) :

```bash
pg_restore --data-only --schema=public --no-owner --no-privileges \
  --dbname="$RESTORE_DB_URL" \
  .tools/prod-backup/hilia-prod-<timestamp>.dump
```

Si `pg_restore` signale un rôle, une extension ou un objet déjà présent,
s'arrêter et relever l'objet en conflit. Ne pas utiliser `--clean`, `DROP
SCHEMA` ou `DROP DATABASE` sur un projet existant. Après restauration,
vérifier `hilia_places`, `hilia_place_details`, les politiques RLS et les
fonctions avec les requêtes de la section 4.

## 3. Migrations à appliquer

L'ordre est impératif :

1. `20261117_hilia_review_fixes.sql`
2. `20261118_hilia_least_privilege.sql`
3. `20261119_hilia_rollback_exact_timestamp.sql`

`20261117` ajoute les champs de normalisation/publication, `hilia_json_number`
et les fonctions corrigées d'approbation. Elle est idempotente, mais ne pas
réappliquer `20261113`, `20261114` ou `20261116` : leurs objets sont déjà
présents en production.

`20261118` révoque les privilèges trop larges de `anon` et `authenticated`,
puis rétablit explicitement les lectures publiques et les écritures prévues par
les politiques RLS. Elle doit être exécutée après `20261117`.

`20261119` remplace uniquement `hilia_import_rollback` pour restaurer
`import_applied_at` à l'identique, y compris `NULL`, au lieu d'inventer
`now()`.

Exécution recommandée, fichier par fichier, en conservant la sortie :

```bash
for f in \
  supabase/migrations/20261117_hilia_review_fixes.sql \
  supabase/migrations/20261118_hilia_least_privilege.sql \
  supabase/migrations/20261119_hilia_rollback_exact_timestamp.sql
do
  echo "Application de $f"
  psql "$HILIA_PROD_DB_URL" -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```

Les fichiers gèrent eux-mêmes `begin`/`commit` ; ne pas ajouter
`--single-transaction` autour d'eux sans avoir vérifié ce point. Ne jamais
appliquer les trois fichiers en un seul bloc sans contrôler le premier.

### 3.1 Contrôles après migration

```sql
select column_name
from information_schema.columns
where table_schema='public' and table_name='hilia_import_records'
  and column_name in ('approval','publication_surface','published_at')
order by column_name;

select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='hilia_json_number';

select has_function_privilege('anon','public.hilia_is_admin()','EXECUTE') as anon_read_ok,
       has_function_privilege('anon',
         'public.hilia_admin_review_decision(text[],text,text)','EXECUTE') as anon_review_must_be_false,
       has_table_privilege('anon','public.hilia_import_records','SELECT') as anon_staging_must_be_false,
       has_table_privilege('anon','public.hilia_places','SELECT') as anon_places_read_ok,
       has_table_privilege('anon','public.hilia_places','UPDATE') as anon_places_update_must_be_false;

select position('import_applied_at = (h.previous_row->>''import_applied_at'')::timestamptz' in prosrc) > 0 as exact_timestamp,
       position('import_applied_at = coalesce' in prosrc) = 0 as no_coalesce
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='hilia_import_rollback';
```

Attendu : les trois colonnes existent ; `hilia_json_number` existe ;
`anon_read_ok = true` ; les deux colonnes `must_be_false` valent `false` ;
`exact_timestamp = true` et `no_coalesce = true`. Le test local
`node scripts/import/test/postgres-review.mjs` applique les six migrations et
vérifie le rollback exact.

## 4. Ordre de déploiement

1. Sauvegarde vérifiée.
2. Migrations `20261117`, `20261118`, `20261119` appliquées et contrôlées.
3. Déploiement du commit de code de cette branche (la fiche `place_imp_…` et la
   file de revue doivent être disponibles avant toute approbation).
4. Vérification du site existant : le catalogue national reste à **54 349**
   fiches, les pages publiques répondent et aucun contenu de test n'apparaît.
5. Import du petit lot ci-dessous, sans import massif.
6. Approbation d'un lieu, régénération du catalogue et déploiement des fichiers
   statiques.
7. Contrôles visiteur, puis seulement ensuite import complet.

Le déploiement du code ne doit pas embarquer `data/places.json` ou les
sitemaps d'un essai `hilia-test`. Après restauration, le diff de ces fichiers
doit être vide avant de committer le code.

## 5. Premier petit lot

Le fichier local `.tools/prod-first-batch.jsonl` (ignoré) contient huit
enregistrements réels du fichier source, sans `Cinémarine` (doublon probable) :

| Type | Identifiant | Nom | Particularité |
| --- | --- | --- | --- |
| Lieu existant | `hilia:0` | Le Klube | enrichissement d'une fiche existante |
| Nouveau lieu | `acceslibre:00d825d4-6eb1-4978-94b1-54a09b3b45bc` | Le Puits salé | validé sans média dans `hilia-test` |
| Nouveau lieu | `acceslibre:02575aea-3901-466e-af9e-0512f4d61e48` | Ecozonia | **4 photos autorisées**, validé dans `hilia-test` |
| Nouveau lieu | `acceslibre:00025aa1-ab74-4880-b032-463fe833d207` | Espace Patrimoine et Paysage | accessibilité déclarée, sans média |
| Activité | `dt:0003c385eb5da23a90322dd8` | U.C.S Canoë-Kayak, Club Marcel Renaud | reste en staging |
| Activité | `dt:0007a54fe4cf23533539c84c` | Vignoble d'exception | reste en staging |
| Itinéraire | `dt:0002088147651ee12caec852` | Villard Reculas en vélo électrique | reste en staging |
| Itinéraire | `dt:000eac3e41cfe743657f09f4` | Randonnée - Les vallons de la Bénèche | reste en staging |

Le SHA-256 du fichier local est
`eb0b9ff3a49a4b1cdc4265489a3ef1c77c1a96f6dc9827bbd26cd285804e594a`.
Il ne doit pas être commité : il contient des données de test opérationnelles.

### 5.1 Importer le lot

Après sauvegarde et migrations, avec la cible production vérifiée :

```bash
npm run import:push -- \
  --source .tools/prod-first-batch.jsonl \
  --execute --batch=8
```

Cette commande crée un run et écrit uniquement le staging et les détails
privés. Elle ne publie aucun lieu. Relever le `run_id` et contrôler :

```sql
select kind, count(*) from public.hilia_import_records group by kind order by kind;
select count(*) from public.hilia_place_details where is_public;
select r.id, r.name, r.review_status, r.publication_surface, r.published_place_id,
       d.is_public, jsonb_array_length(coalesce(d.media,'[]'::jsonb)) as media_count
from public.hilia_import_records r
left join public.hilia_place_details d on d.place_id=r.published_place_id
where r.id='acceslibre:02575aea-3901-466e-af9e-0512f4d61e48';
```

Attendu : 8 enregistrements, 0 détail public avant approbation, et le détail
d'Ecozonia privé avec **4 médias**. Les activités et itinéraires restent en
staging.

### 5.2 Approuver un seul lieu et vérifier

Dans **Administration → Nouveaux contenus importés**, se connecter avec un
compte administrateur de production, sélectionner **Ecozonia** et approuver.
Le test `hilia-test` a utilisé la même RPC avec un contexte administrateur :

```sql
select r.id, r.review_status, r.publication_surface, r.published_place_id,
       d.is_public, d.media
from public.hilia_import_records r
left join public.hilia_place_details d on d.place_id=r.published_place_id
where r.id='acceslibre:02575aea-3901-466e-af9e-0512f4d61e48';
```

Attendu : `review_status=approved`, `publication_surface=hilia_places`,
`published_place_id=place_imp_e1082db1846a44e660ea`, détail public avec quatre
URLs, crédits, source et licence. Le contrôle visiteur doit être fait après
régénération et déploiement du catalogue, pas avant.

Les autres nouveaux lieux restent en revue (`accessibility_review`) ; les
activités et itinéraires restent `staging_only`.

### 5.3 Régénérer et publier les fichiers statiques

Avec les variables de production et la clé **publishable** (jamais la clé
service_role) :

```bash
npm run data
npm run import:build
```

`npm run data` réécrit `data/places.json` et les sitemaps. Avant le premier lot
le catalogue compte 54 349 fiches ; après approbation d'Ecozonia, il doit en
compter **54 350** (la base en aura 54 351, moins l'exclusion 29088). Vérifier
qu'aucune fiche de test (`Cinémarine`, données de validation) n'apparaît. Puis
committer uniquement le catalogue et les fichiers générés destinés à la
production, et déployer ce commit.

## 6. Import complet et contrôles après publication

Une fois le petit lot, l'affichage anonyme et les médias validés :

```bash
npm run import:push -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl" --execute
# en cas d'interruption :
npm run import:push -- --run-id "<uuid>" --execute --resume
```

L'import massif ne publie rien automatiquement. Les approbations restent
manuelles et par lots ; les 4 069 rapprochements incertains ne doivent pas être
approuvés en masse. Après les approbations prévues, relancer `npm run data` et
`npm run import:build`, puis déployer.

Contrôles SQL après import :

```sql
-- volumes et statuts
select (select count(*) from public.hilia_places) as places,
       (select count(*) from public.hilia_place_details) as details,
       (select count(*) from public.hilia_import_runs) as runs,
       (select count(*) from public.hilia_import_records) as records;

-- aucun détail public ne doit pointer vers une fiche non approuvée
select count(*) as public_details_without_approved_place
from public.hilia_place_details d
where d.is_public
  and not exists (
    select 1 from public.hilia_places p
    where p.id=d.place_id and p.status='approved'
  );

-- surfaces incohérentes
select count(*) as approved_place_without_surface
from public.hilia_import_records
where kind='place' and review_status='approved'
  and publication_surface is not null
  and publication_surface <> 'hilia_places';

select count(*) as approved_activity_or_route_published
from public.hilia_import_records
where kind in ('activity','route') and review_status='approved'
  and publication_surface='hilia_places';
```

Attendu : aucun détail public orphelin, aucune activité/itinéraire sur
`hilia_places`, et les compteurs du catalogue correspondent aux fiches
approuvées moins les exclusions qualité.

Contrôles statiques et navigateur :

```bash
node -e "const d=require('./data/places.json'); console.log({count:d.count, rows:d.rows.length, testId:d.rows.some(r=>/Cinémarine/.test(String(r[1])))})"
grep -R "Cinémarine" data/places.json sitemap*.xml && echo 'ERREUR: fiche de test présente' || true
```

Pour un lieu approuvé `place_imp_…`, vérifier sans session :

- la recherche renvoie la fiche ;
- la page `/lieu/<slug>` s'ouvre et le détail vient de `hilia_place_details` ;
- chaque image a un `naturalWidth > 0` via `/api/media` ;
- chaque légende affiche le crédit, la source et la licence ;
- le staging et l'approbation anonyme répondent `401/403`.

### 6.1 Erreur 400 du proxy média

Le proxy `/api/media` lit le paramètre **`u`**, pas `url` :
`/api/media?u=https%3A%2F%2F…`. Un contrôle manuel qui utilisait
`/api/media?url=…` recevait donc `400 Média non autorisé`, alors que le client
du site construisait déjà ses URLs avec `u`.

Ne pas changer le proxy pour accepter `url` : cette différence est volontaire
et évite d'élargir la surface du relais. Le contrôle ciblé vérifie que le client
et le proxy restent alignés :

```bash
npm run test:import
# test « le client et le proxy partagent le paramètre média u »
```

Le test `scripts/import/test/media-proxy.test.mjs` échoue si `app.js` utilise
`?url=` ou si le proxy ne lit plus `u`. En cas de 400, vérifier d'abord le nom du
paramètre, puis l'hôte dans `lib/media-hosts.js` ; un hôte absent produit aussi
un 400, tandis qu'une récupération distante impossible produit un 502.

## 7. Retour arrière et limites

### 7.1 Avant approbation

```bash
npm run import:push-postgres -- --rollback "<run_id>" --execute
```

Le rollback supprime les détails et enregistrements créés par ce run et
restaure les détails préexistants depuis `hilia_place_detail_history`, y compris
`import_applied_at`. Il ne supprime **jamais** une fiche `hilia_places`.

Il ne restaure **pas** les valeurs antérieures des enregistrements de staging
qui existaient déjà : les huit contenus du premier lot resteraient dans leur
état réimporté, avec `last_seen_run` pointant vers le nouveau run. Seules les
lignes `hilia_place_details` correspondantes sont restaurées. Les décisions
`approved` et `rejected` ne sont pas écrasées par le réimport, mais cela ne
constitue pas une restauration du staging.

### 7.2 Après approbation

Le rollback d'un run **ne dépublie pas** une fiche approuvée. Pour retirer une
fiche publiée par erreur, faire une décision éditoriale distincte :

```sql
begin;
update public.hilia_places
set status='rejected'
where id='<place_id>';
update public.hilia_place_details
set is_public=false
where place_id='<place_id>';
commit;
```

Puis régénérer `data/places.json` et les sitemaps, vérifier que l'ID a disparu
du catalogue, et redéployer. Ne pas supprimer la ligne : elle conserve la trace
de l'import et de la décision.

### 7.3 Limites

- Les migrations n'ont pas de script de descente. En cas de problème de schéma,
  restaurer une sauvegarde dans un projet neuf ou utiliser le PITR Supabase ;
  ne pas improviser de `DROP` sur la production.
- `20261118` révoque des privilèges : une restauration partielle ou un dump
  ancien peut les rétablir. Rejouer les contrôles ACL après toute restauration.
- Le rollback ne supprime ni les fiches `hilia_places`, ni les avis, ni les
  suggestions, ni les contenus publiés après le run.
- Le rollback ne restaure pas les anciennes valeurs des enregistrements de
  staging déjà existants : il les laisse dans leur état réimporté. Il ne faut
  donc pas le présenter comme une restauration complète du staging.
- Le test média ne couvre que les quatre photos d'Ecozonia et le proxy local ;
  il ne prouve pas la disponibilité des 149 637 URLs du paquet complet.
- La restauration du dump n'a pas été exécutée sur la production : seul
  `pg_restore --list` a vérifié l'archive. Une restauration à blanc dans un
  projet jetable reste à faire avant le go-live.
- Aucun import massif, aucune approbation et aucune écriture n'ont été faits en
  production pendant cette préparation.

## 8. Préparation de l'import complet : chemin direct et delta public

### 8.1 Chemin réellement utilisable

La clé `service_role` disponible localement appartient au projet Supabase de
**test** (`HILIA_TEST_PROJECT_REF`), pas à la production. `push.mjs` ne peut donc
pas écrire en production via l'API REST. Le chemin utilisable est PostgreSQL
direct avec `HILIA_PROD_DB_URL`, l'outil versionné
`scripts/import/push-postgres.mjs` et les fonctions SQL déjà déployées. La
dépendance `pg` est déclarée dans `devDependencies`.

L'outil découpe en lots de 200 (maximum 500), journalise chaque lot, ne déplace
le curseur qu'après le commit transactionnel du staging et des détails, et
expose :

```bash
npm run import:push-postgres -- --run-id <uuid> --execute --resume
npm run import:push-postgres -- --rollback <uuid> --execute
```

Commande complète de lancement, une fois `HILIA_PROD_DB_URL` chargée depuis
l'environnement local (aucun secret dans le dépôt) :

```bash
set -a; . ./.env.hilia-test.local; set +a
npm run import:push-postgres -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl" --execute
```

Le chemin a été testé sur le projet de test, pas en production : reprise après
un arrêt au premier lot, puis rollback. Le rollback a restauré les quatre
détails préexistants, supprimé zéro fiche et conservé les approbations du
projet de test. En production, les huit enregistrements du premier lot seront
mis à jour, jamais recréés ; Ecozonia restera `approved` et son détail public
restera `is_public=true`.

Volumes calculés : **239 314** enregistrements importables, dont **239 306
créations et 8 mises à jour**. Les détails représentent **166 730** lignes :
**166 726 créations et 4 mises à jour**. Après import, **54 350** détails sont
publics : **54 349** fiches existantes + **Ecozonia**, déjà approuvée. Les
**112 380** autres nouveaux lieux restent privés. `hilia_places` n'est pas
modifiée par l'import complet (aucune création, aucune mise à jour).

### 8.2 Delta des fichiers publics avec la production

Comparaison effectuée le 17 novembre 2026 entre le build local et les fichiers
actuellement servis :

- catalogue : **54 350** lignes des deux côtés, hash identique ;
- détails de lieux : **54 349** localement contre **26 650** en production, soit
  **27 700** identifiants locaux seulement et **1** identifiant seulement en
  production (`29088`, exclusion qualité) ; les 256 shards changent ;
- événements : **17 634** localement contre **17 707** en production ; **0**
  événement ajouté, **73** supprimés car terminés le 16 novembre ; aucun nouvel
  événement ne devient visible ;
- détails d'événements : 17 634 contre 17 707 ; 7 669 médias contre 7 700 ;
- médias de lieux : 2 327 dans les deux builds ;
- hôtes média autorisés : les **22** mêmes hôtes dans le build local et le code
déployé.

Règle d'un événement public : `candidate_event`, dates explicites, occurrence non
terminée, durée inférieure ou égale à 90 jours, début dans les cinq ans ; les
`review_dates`, événements sans date et occurrences expirées sont exclus.

**Ne pas déployer les 137,81 Mo de données générées avant validation de ce
delta.** Sur les **112 381** nouveaux lieux bruts, Ecozonia est déjà publiée ;
les **112 380** autres détails restent privés jusqu'à approbation.

### 8.3 Sauvegarde fraîche

Une sauvegarde a été créée le 17 novembre 2026 à 10:46 UTC dans
`.tools/prod-backup/hilia-prod-20261117T104625.dump` et copiée dans
`OneDrive/HILIA-BACKUPS/20261117T104625/`. L'archive contient 786 entrées TOC,
les hashes locaux et ceux de la copie OneDrive concordent. La présence effective
dans OneDrive web reste à confirmer humainement.
