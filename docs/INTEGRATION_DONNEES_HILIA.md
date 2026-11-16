# Intégration des données enrichies HILIA

Ce document décrit l'import du paquet `HILIA_DONNEES.jsonl` (843 Mo), les
fichiers produits, les commandes de simulation et la procédure Supabase. Aucun
secret n'est présent dans le dépôt.

## 1. Ce qui a été contrôlé

Le paquet contient **239 445 enregistrements** :

| Type | Volume |
| --- | ---: |
| Lieux | 166 731 |
| Événements | 58 279 |
| Activités / prestations | 8 803 |
| Itinéraires | 5 501 |
| Catégories | 130 |
| Manifeste | 1 |

Les **54 349** identifiants HILIA encore publiés ont tous été retrouvés dans le
snapshot `data/places.json` : aucun ID n'est renuméroté. Les 110 écarts de nom
observés sont des espaces multiples ou des caractères invisibles nettoyés à
l'affichage, pas des changements d'identité. La fiche `29088` a été retirée
après contrôle qualité (voir ci-dessous), d'où l'écart avec les 54 350 fiches
initialement mesurées.

Le fichier n'est pas un NDJSON strict : des descriptions contiennent des retours
à la ligne bruts. `scripts/import/lib/read-jsonl.mjs` recolle ces fragments en
échappant la coupure ; 90 enregistrements ont nécessité cette réparation. Toute
autre erreur de syntaxe arrête l'import.

### Statuts conservés

- `existing_preserved` : fiche publique existante, enrichie sans certification.
- `candidate_declared_accessibility` et `review_accessibility` : candidats dont
  l'accessibilité reste à qualifier ; ils ne sont pas publiés.
- `review_duplicate` : 4 069 enregistrements avec 8 719 correspondances
  incertaines ; ils restent hors publication.
- `candidate_event` : dates explicites, accessibilité non garantie. Uniquement
  ces événements, non terminés, d'une durée maximale de 90 jours et démarrant
  dans les cinq ans, alimentent l'agenda public. Les 1 535 périodes trop longues
  et 2 dates aberrantes sont écartées pour revue.
- `review_dates` : calendrier à vérifier ; **33 153 événements exclus** de
  l'agenda.

### Couverture utile

- 174 020 descriptions, dont 2 242 utilisables pour les fiches existantes.
- 169 397 URLs de médias dans le paquet ; 149 637 marquées
  `eligible_with_credit`.
- 57 002 enregistrements avec des horaires exploitables.
- 79 134 avec des prix ou offres structurés.
- 150 756 avec au moins un contact.
- 112 942 avec au moins une observation d'accessibilité.
- 37 708 événements sans date exploitable (pointeurs `data:` ou calendrier
  incomplet), donc non publiés.

Une information absente reste `null`. Elle n'est jamais transformée en
« accessible » ou « inaccessible ». Les observations HILIA et Acceslibre
contradictoires sont conservées séparément. Le nombre de marches est conservé
comme valeur numérique, y compris `0`.

### Retrait qualité et file de revue

La fiche `29088` (« Direction départementale des finances publiques (DDFIP) -
Moselle ») a été contrôlée le 16 novembre 2026 : catégorie source `Casino`,
activité `Casino`, lien `contact_url` vers `cnil.fe` et sources
`hilia:29088` / `acceslibre:93cb7b86-273d-4ce1-9746-1d9f3ff2845d`. Ces champs
ne décrivent pas un lieu de loisirs fiable. Le retrait est réversible et tracé
dans `data/place-exclusions.json` ; `lib/place-exclusions.js` le lit à la
construction du catalogue et `lib/place.js` renvoie `null` pour l'ID, donc
l'API et la page de fiche répondent `404`. Le build et le push marquent aussi
la fiche `quality_review`, `auto_publishable=false` et `review_level=manual`
si elle revient dans une source : un nouvel import ne peut pas la republier
automatiquement. Les sources et l'historique restent dans les données
brutes ; aucune autre fiche n'a été retirée sur simple correspondance de nom.

Les candidats qui ne satisfont pas les règles de publication restent en
staging. Ils ne sont ni fusionnés avec un événement, ni publiés pour atteindre
un volume cible. Le dernier build recense **112 381 nouveaux lieux**, **8 803
activités** et **5 501 itinéraires** en attente d'import/revue ; ils ne font
pas partie des 54 349 lieux publics.

Le catalogue public conserve **66 catégories d'activités** détaillées, sans
plafond codé. Pour l'affichage uniquement, le sélecteur les regroupe en six
familles : Sport & mouvement, Culture & patrimoine, Plein air & nature,
Loisirs & détente, Tourisme & découverte et Lieux de réception. Cette
regroupement ne fusionne aucun identifiant et ne crée aucune catégorie
supplémentaire ; les compteurs restent calculés sur les fiches publiées.
`scripts/build-dataset.mjs` normalise les libellés mal décodés avant de
calculer les index, afin qu'un synonyme d'encodage ne crée pas une catégorie
fantôme.

## 2. Fichiers produits

| Fichier | Rôle |
| --- | --- |
| `data/place-details/NNN.json` | 256 shards de détails pour les fiches existantes, chargés à la demande. |
| `data/events.json` | Index compact de l'agenda (17 707 événements à occurrence datée et durée plausible, après retrait des occurrences terminées au 16 novembre 2026). |
| `data/event-details/NNN.json` | 128 shards de détails d'événements, chargés au clic. |
| `lib/media-hosts.js` | Allowlist générée des 22 domaines d'images affichés. |
| `data/import-preview/audit-source.json` | Audit complet, compteurs et chemins de champs. |
| `data/import-preview/simulation.json` | Résultat de la simulation, sans mutation. |
| `data/import-preview/build-report.json` | Rapport de génération publique. |
| `supabase/migrations/20261113_hilia_import.sql` | Staging, détails, événements, activités, itinéraires, médias, RLS et fonctions. |
| `supabase/migrations/20261114_hilia_review.sql` | Revue par lots, historique des détails et rollback exact. |
| `supabase/migrations/20261116_hilia_restore_public_read.sql` | Restaure l'exécution de `hilia_is_admin()` nécessaire aux politiques RLS publiques. |
| `supabase/migrations/20261117_hilia_review_fixes.sql` | Correctif idempotent : catégories, site/coordonnées, transfert d’enrichissement, publication réelle et cast du rollback. |
| `supabase/migrations/20261118_hilia_least_privilege.sql` | Réduction des privilèges de `anon` et `authenticated` ; lectures publiques et écritures RLS explicitement accordées. |
| `supabase/migrations/20261119_hilia_rollback_exact_timestamp.sql` | Restaure exactement `import_applied_at`, y compris `NULL`, lors du rollback. |
| `scripts/import/lib/publication.mjs` | Politique de publication et motifs de revue. |
| `scripts/import/*.mjs` | Audit, construction, import Supabase, tests. |
| `api/media.js`, `lib/media-policy.js` | Proxy d'images à liste blanche, sans SSRF ouverte. |

L'agenda est une page `/agenda`, distincte des fiches de lieux. Une affiche
d'événement ne peut jamais devenir la photo d'un bâtiment : les médias de lieu
n'acceptent que `scope = place`, et les affiches sont écartées.

## 3. Commandes locales

Le fichier source reste hors du dépôt. Le chemin peut être passé par
`--source` ou `HILIA_SOURCE`.

```bash
# Audit du fichier (écrit data/import-preview/audit-source.json)
npm run import:audit -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl"

# Simulation : lit le fichier, ne modifie ni les données publiques ni Supabase
npm run import:simulate -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl"

# Génération publique à partir du même fichier
npm run import:build -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl"

# Tests de non-régression de l'import
npm run test:import
```

`npm run import:build` réécrit uniquement les répertoires générés
`data/place-details/`, `data/event-details/`, `data/events.json` et
`lib/media-hosts.js`. Il ne touche jamais `data/places.json`,
`hilia_reviews`, `hilia_suggestions`, `hilia_place_edits`, les comptes ou les
images privées `provider-visuals`.

Après un import Supabase de nouvelles fiches approuvées, relancer
`npm run data` pour le catalogue et les sitemaps, puis `npm run import:build`
pour les détails enrichis. `npm run pages` régénère les pages HTML.

## 4. Procédure Supabase

### 4.1 Préparer

1. Sauvegarder la base (Supabase → Database → Backups).
2. Vérifier le type réel de `hilia_places.id` et les politiques RLS existantes.
3. Exécuter **tout** `supabase/migrations/20261113_hilia_import.sql` dans le
   SQL Editor. La migration ne remplace aucune table existante.
4. Exécuter ensuite **tout** `supabase/migrations/20261114_hilia_review.sql`,
   dans le même projet. Elle ajoute les colonnes de revue, l’historique des
   détails et les RPC d’administration ; elle ne supprime aucune fiche.
5. Exécuter enfin `supabase/migrations/20261116_hilia_restore_public_read.sql`.
   Elle rend `hilia_is_admin()` exécutable par `anon`, car les politiques RLS
   publiques l’appellent ; sans elle, les lectures de `hilia_places` et de
   `hilia_place_details` répondent 401. La fonction ne renvoie `true` qu’à un
   administrateur connecté.
6. Exécuter ensuite **tout** `supabase/migrations/20261117_hilia_review_fixes.sql`.
   Cette migration corrective est idempotente : elle doit être appliquée aussi
   sur une base qui a déjà reçu les migrations précédentes. Elle corrige le
   cast uuid du rollback, la lecture des catégories, le transfert de
   l’enrichissement et l’état de publication des activités et itinéraires.
   Pour une installation neuve, les fichiers 20261114 et 20261117 sont tous
   deux exécutés ; le second reste la référence corrective.
7. Exécuter **tout** `supabase/migrations/20261118_hilia_least_privilege.sql`.
   Cette migration révoque les privilèges trop larges de `anon` et
   `authenticated`, puis rétablit explicitement les lectures publiques et les
   écritures autorisées par les politiques RLS. Elle doit être appliquée après
   `20261117`.
8. Exécuter enfin **tout** `supabase/migrations/20261119_hilia_rollback_exact_timestamp.sql`.
   Elle remplace `hilia_import_rollback` pour restaurer `import_applied_at` à
   l'identique, y compris `NULL`, au lieu de fabriquer un timestamp.

Pour le passage en production, la sauvegarde, l'ordre de déploiement, le petit
lot et les contrôles post-publication sont détaillés dans
[`docs/GO_LIVE_HILIA.md`](GO_LIVE_HILIA.md).

La migration crée :

- `hilia_import_runs`, `hilia_import_batches`, `hilia_import_records` et
  `hilia_import_created` : staging, journal, reprise et rollback.
- `hilia_place_details` : descriptions, médias, horaires, prix, contacts et
  observations d'accessibilité des lieux existants.
- `hilia_events`, `hilia_leisure_activities`, `hilia_routes` : entités séparées.
- `hilia_media` : médias avec crédit, licence, dates de droits et statut.
- `hilia_import_upsert`, `hilia_upsert_place_details` et
  `hilia_import_rollback` : opérations idempotentes et retour arrière.
- `hilia_place_detail_history` : état précédent de chaque détail touché par un
  run, pour restaurer une fiche existante.
- `hilia_is_admin`, `hilia_admin_review_queue` et
  `hilia_admin_review_decision` : file de revue et décisions par lots, réservées
  aux membres de `hilia_user_roles` ayant le rôle `admin`.

Les tables `hilia_import_*` ne sont pas lisibles avec la clé publishable. Les
détails d'un lieu ne deviennent publics que si `hilia_places.status = 'approved'`
au moment de l'upsert. `push.mjs` alimente le staging complet et
`hilia_place_details` ; `hilia_events`, `hilia_leisure_activities`,
`hilia_routes` et `hilia_media` sont créées comme cibles de promotion et
restent vides tant qu'une revue ne les alimente pas. L'agenda public est généré
statiquement depuis les occurrences datées ; les tables normalisées ne sont pas
encore utilisées par le site.

### 4.2 Renseigner la clé côté serveur

La clé `service_role` ne doit jamais être dans le navigateur, un fichier
versionné ou un message. Dans un terminal local :

```bash
export SUPABASE_URL="https://<projet>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<clé service_role>"
```

PowerShell :

```powershell
$env:SUPABASE_URL="https://<projet>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<clé service_role>"
```

Sur Vercel, ne pas ajouter cette clé aux variables publiques. L'import est une
opération d'administration exécutée localement ou dans un runner protégé.

Pour régénérer le catalogue avec un projet de test, exporter aussi sa clé
**publishable** : `SUPABASE_KEY` est utilisée par `npm run data`. Sans elle, le
script interroge le projet HILIA par défaut, pas le projet de test.

### 4.3 Simuler puis exécuter

```bash
# Plan sans écriture (affiche la cible et les options)
npm run import:push -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl"

# Écriture réelle, par lots de 200
npm run import:push -- --source "D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl" --execute

# Reprise après interruption
npm run import:push -- --run-id "<uuid>" --execute --resume

# Retour arrière des seules lignes créées par ce run
npm run import:push -- --rollback "<uuid>" --execute
```

Options utiles : `--kinds=place,event`, `--limit=1000`, `--batch=200`.
Le curseur de reprise n’est mis à jour qu’après l’écriture du staging **et**
des détails du lot. Si l’une des deux écritures échoue, le curseur reste au
dernier lot complet : relancer avec `--resume` rejoue le lot incomplet au lieu
de le sauter. Une interruption pendant un lot peut donc réécrire ce lot, ce qui
est sans effet grâce aux upserts idempotents.
Le rollback ne supprime jamais une ligne antérieure au run ni une ligne qui a
été mise à jour depuis ; il supprime les créations du run et marque le run
`rolled_back`. Pour les fiches existantes enrichies, il restaure depuis
`hilia_place_detail_history` les champs de contenu présents avant le run
(description, catégories, médias, horaires, prix, contacts, accessibilité,
sources, partition de licences, visibilité et provenance). Il supprime seulement
les détails créés par ce run ; il ne supprime **jamais** une fiche
`hilia_places`, un avis, une suggestion ou un contenu publié après le run. En
particulier, une fiche créée par une approbation reste publique après le
rollback du run d’import : pour la retirer, il faut une décision éditoriale
distincte sur `hilia_places`.

#### 4.3.1 Petit import de validation

Avant le volume complet, construire un échantillon avec quelques vrais
enregistrements (un lieu existant enrichi, cinq nouveaux lieux, deux activités
et deux itinéraires), sans copier tout le fichier :

```bash
node --input-type=module <<'NODE'
import { createWriteStream } from 'node:fs';
import { readHiliaJsonl } from './scripts/import/lib/read-jsonl.mjs';
const source = 'D:/HILIA AHAHAHH/HILIA_Donnees_et_Prompt/HILIA_DONNEES.jsonl';
const out = createWriteStream('data/import-preview/validation.jsonl');
const wanted = { existing: 1, newPlace: 5, activity: 2, route: 2 };
const seen = { existing: 0, newPlace: 0, activity: 0, route: 0 };
for await (const { record } of readHiliaJsonl(source)) {
  if (record.kind === 'manifest') { out.write(JSON.stringify(record) + '\n'); continue; }
  if (record.kind === 'category' || record.kind === 'event') continue;
  const key = record.kind === 'place' ? (record.existing_hilia_id ? 'existing' : 'newPlace') : record.kind;
  if (seen[key] >= wanted[key]) continue;
  out.write(JSON.stringify(record) + '\n');
  seen[key] += 1;
  if (Object.keys(wanted).every((k) => seen[k] >= wanted[k])) break;
}
await new Promise((resolve) => out.end(resolve));
NODE

npm run import:push -- --source data/import-preview/validation.jsonl --execute --batch=5
```

Contrôler ensuite, avant toute approbation :

```sql
select kind, count(*)
from public.hilia_import_records
group by kind order by kind;
select count(*) from public.hilia_place_details where not is_public;
```

Dans **Administration → Nouveaux contenus importés**, approuver un seul nouveau
lieu. Vérifier que `published_place_id` correspond à `place_imp_…` et que le
détail est devenu lisible :

```sql
select r.id, r.published_place_id, r.publication_surface, d.is_public,
       d.description, d.media, d.contacts, d.accessibility
from public.hilia_import_records r
left join public.hilia_place_details d on d.place_id = r.published_place_id
where r.id = '<id du lieu approuvé>';
```

Pour voir la fiche et son enrichissement dans le site local, régénérer le
catalogue statique puis démarrer le serveur :

```bash
npm run data
npm run dev
```

Le nouveau lieu `place_imp_…` est ajouté à `data/places.json` ; son détail est
lu depuis Supabase par `app.js`, car les shards `data/place-details/` ne
contiennent que les identifiants du catalogue historique. Cette étape écrit
`data/places.json` et les sitemaps : vérifier le diff et ne pas committer
l’échantillon de validation.
Le serveur local injecte l’URL et la clé **publishable** du projet test dans
`/app.js` à partir de `SUPABASE_URL` et `SUPABASE_KEY` (voir
`docs/SUPABASE_TEST_ENVIRONMENT.md`). Sans ces variables, il retombe sur les
constantes de production : vérifier la ligne `HILIA : Supabase local ciblé sur …`
dans la console avant de contrôler l’affichage. Ne jamais y placer de clé
`service_role`.

### 4.4 Vérifier

```sql
select count(*) as lignes from public.hilia_import_records;
select count(*) as details from public.hilia_place_details where is_public;
select kind, count(*) from public.hilia_import_records group by kind order by kind;
select count(*) from public.hilia_import_created where run_id = '<uuid>';
select id, kind, review_status, publication_surface, published_place_id
from public.hilia_import_records
where review_status = 'approved';
```

Deux exécutions identiques doivent laisser les mêmes compteurs : l'upsert est
clé sur `id` et `(source, source_id)`. Les fichiers statiques peuvent être
régénérés sans double emploi. Une décision humaine `approved` ou `rejected`
n’est pas annulée par un réimport : le statut de revue est conservé.

### 4.5 État vérifié au 16 novembre 2026

- Le site public statique fonctionne avec **54 349** fiches et **17 707**
  événements à venir. Ces contenus sont générés dans le dépôt et publiés par
  le déploiement Vercel ; ils ne dépendent pas de la lecture Supabase.
- La lecture publique de `hilia_places`, `hilia_place_details` et
  `hilia_reviews` a été vérifiée à `200` sur le site déployé le 16 novembre
  2026, après avoir reproduit un `401` (`42501 permission denied for function
  hilia_is_admin`) avant la correction. La migration
  `20261116_hilia_restore_public_read.sql` reste le correctif versionné à
  appliquer sur tout nouvel environnement.
- Le projet `hilia-test` dispose de ses propres variables locales ignorées par
  Git ; il a reçu les six migrations, un import de validation, une approbation
  et un rollback. La production n'a reçu **aucune écriture** d'import.
- Le test `hilia-test` a approuvé **Le Puits salé** (sans média) puis
  **Ecozonia** (quatre photos) ; la fiche, la recherche anonyme, `/api/media`
  et les crédits ont été vérifiés dans un navigateur sans session.
- Aucune ligne des **112 381** nouveaux lieux, **8 803** activités et **5 501**
  itinéraires n'a été importée ou publiée en production. Le staging est
  construit et testé, mais l'import massif reste volontairement non lancé.

Les migrations `20261117`, `20261118` et `20261119` restent à appliquer en
production. La commande exacte est celle de la section 4.3
(`npm run import:push -- ... --execute`), après sauvegarde et contrôles du
runbook [`docs/GO_LIVE_HILIA.md`](GO_LIVE_HILIA.md). Pour appliquer seulement
le correctif de lecture publique, ouvrir le SQL Editor du projet Supabase et
coller tout le fichier
`supabase/migrations/20261116_hilia_restore_public_read.sql`, puis vérifier
avec les requêtes de la section 4.4.

### 4.6 Politique de publication et revue par lots

Aucun nouveau lieu, activité ou itinéraire n’est auto-publié. La décision est
consignée dans `hilia_import_records` avec `review_level`, `review_reasons` et
`review_status`. L’interface d’administration affiche la file, les sources et
les motifs, puis approuve, refuse ou laisse à revoir une sélection.

| Candidat | Niveau | Publication après approbation |
| --- | --- | --- |
| Nouveau lieu avec nom, source et localisation | `batch` | Crée une fiche `hilia_places` approuvée et transfère description, photos autorisées avec crédits, contacts, horaires, tarifs, sources et accessibilité. Une absence reste `_unknown = true` ; `publication_surface = 'hilia_places'`. Visible seulement après `npm run data`. |
| Nouveau lieu sans nom, sans source, sans localisation, avec coordonnées invalides, doublon probable ou aucune surface publique | `manual` | Revue individuelle obligatoire. |
| Activité ou itinéraire | `manual` | `approved` signifie **validé en staging**, pas publié : `publication_surface = 'staging_only'`, `published_at = NULL`, aucune fiche publique. |
| Enrichissement d’une fiche existante | automatique pour les détails | Les détails sont appliqués à `hilia_place_details` ; l’identité publique existante n’est pas recréée. |
| Événement sans date ou `review_dates` | jamais publié dans l’agenda | Reste hors agenda tant que le calendrier n’est pas vérifié. |

Une accessibilité inconnue n’est jamais convertie en « accessible ». Elle est
affichée « Accessibilité non renseignée » sur la carte et la fiche, et
`_unknown` est conservé dans `access` et dans le catalogue statique.

Contrôle en lecture (après toutes les migrations) :

```sql
-- File des lieux en attente, avec leurs motifs
select id, name, source, source_id, review_level, review_reasons
from public.hilia_import_records
where kind = 'place' and review_status not in ('approved','rejected')
order by created_at desc
limit 50;
```

Après une approbation, contrôler la surface réelle :

```sql
select id, kind, publication_surface, published_place_id, published_at
from public.hilia_import_records
where review_status = 'approved'
order by reviewed_at desc
limit 50;
```

La décision se prend dans **Administration → Nouveaux contenus importés** :
la RPC vérifie `auth.uid()` contre `hilia_user_roles` et ne peut pas être
remplacée par un simple appel SQL Editor sans jeton utilisateur.

## 5. Médias et licences

Le site ne charge jamais un domaine producteur directement. Il appelle
`/api/media?u=...` ; le proxy :

- n'accepte que les 22 hôtes de `lib/media-hosts.js` ;
- refuse les adresses privées, locales, les ports inattendus et les identifiants
  dans l'URL ;
- revalide chaque redirection (3 maximum) ;
- n'accepte que `image/*`, 8 Mo maximum ;
- ne transmet aucun cookie et masque le détail des erreurs.

Les médias affichés portent toujours crédit, source et licence. Les statuts
`expired`, `not_yet_valid`, `review_rights_or_format` et `review_image_rights`
ne sont pas affichés. Un crédit « Non communiqué » n'est pas considéré comme un
crédit exploitable. Les dates de droits sont recontrôlées à la génération ; le
proxy et le CDN ont un cache borné.

Licences conservées par source :

- Acceslibre et Muséofile : Licence Ouverte 2.0, attribution et date.
- DATAtourisme : licence et producteur d'origine, crédits et dates des médias.
- Que faire à Paris : ODbL 1.0, partition `paris_odbl`.
- Les données HILIA existantes restent internes.

Ne pas présenter un import comme un partenariat ni comme une certification
HILIA. La mention « vérifié par HILIA » reste réservée à un contrôle humain
réel.

## 6. Interface

- **Fiche lieu** : description, galerie de photos avec crédit, horaires, tarifs,
  contacts, catégories fines et sources d'accessibilité. Les détails sont chargés
  après l'ouverture de la fiche, depuis un shard de 256. Pour un nouveau lieu
  approuvé (`place_imp_…`), qui n’a pas encore de shard, `app.js` lit le détail
  public dans `hilia_place_details` via les politiques RLS.
- **Agenda** : recherche, famille, dates, gratuité explicite. Les événements
  `review_dates` et les événements sans date sont absents. Le détail charge un
  shard de 128, affiche les dates, tarifs, contacts, accessibilité déclarée et un
  lien de réservation externe lorsqu'il existe.
- Les données structurées `Event` sont ajoutées à l'ouverture d'un événement.
- Si une photo ne répond pas, le SVG de catégorie existant la remplace avec la
  mention « Image indisponible · illustration HILIA » ; il n'est jamais présenté
  comme une photo du lieu.
- Le catalogue de base reste `data/places.json` ; aucun JSONL n'est envoyé au
  navigateur.

## 7. Tests exécutés

```text
npm run test:import
34 tests : parser multi-lignes, vrai/faux/null, horaires expirés, prix
gratuit/payant, droits des médias, affiches, observations contradictoires,
dates d’événements, IDs existants, shards, séparation lieux/événements,
allowlist du proxy, politique de revue, cycle push → échec du staging →
reprise → rollback, échec des détails sans avance du curseur, et reprise
`--batch=200`, le tout contre un faux PostgREST.

PostgreSQL 18.6 réel, cluster temporaire local :

```bash
npm install --no-save --package-lock=false embedded-postgres
node scripts/import/test/postgres-review.mjs
```

Ce test applique 20261113, 20261114, 20261116, 20261117, 20261118 et
20261119 (puis rejoue la dernière pour vérifier son idempotence), approuve deux
nouveaux lieux, vérifie la catégorie chaîne, le site, les coordonnées, le
transfert du détail, la partition de licences, l’accessibilité inconnue, les
surfaces `hilia_places` / `staging_only`, `p_ids = NULL`, puis le rollback et
la conservation exacte de `import_applied_at` (`NULL` et timestamp non nul).
Limite explicite : ce test utilise un `hilia_places` minimal et des tables
historiques stub, pas le schéma Supabase de production complet.
```

La simulation et la génération ont été exécutées sur le fichier réel. Résultat :
54 350 IDs existants retrouvés, 26 650 fiches enrichies, 19 024 événements
publiés, 33 153 événements en revue de dates exclus, 1 535 périodes trop
longues et 2 dates aberrantes écartées, 112 381 nouveaux lieux, 8 803 activités
et 5 501 itinéraires laissés en staging.

## 8. État de préparation et ce qui reste

- Le projet `hilia-test` a reçu un import de validation, une approbation et une
  fiche avec photos ; la production n'a reçu **aucune écriture** d'import.
- Le test `hilia-test` a validé Le Puits salé (sans média) et Ecozonia (quatre
  photos autorisées) : recherche, fiche anonyme, `/api/media` et crédits. Le
  catalogue et les sitemaps de production ont ensuite été restaurés depuis
  `.tools/catalog-before/`.
- Les migrations `20261117`, `20261118` et `20261119` sont encore absentes de
  la production : les appliquer avant tout import, dans cet ordre. Le runbook
  [`docs/GO_LIVE_HILIA.md`](GO_LIVE_HILIA.md) contient les contrôles et l'ordre
  de déploiement.
- Le repli de `app.js` qui lit le détail d’un nouveau lieu `place_imp_…` dans
  Supabase a été exercé dans un navigateur sur `hilia-test`.
- Les parcours authentifiés avancés (avis, suggestions, interface
  d’administration) n’ont pas tous été parcourus dans l’interface ; la décision
  d’approbation a été vérifiée via la RPC avec un contexte administrateur de
  test.
- Vérifier les politiques RLS et le type de `hilia_places.id` sur la base réelle.
- Contrôler les 4 069 rapprochements incertains avant toute publication de
  nouveaux lieux.
- Faire relire les 19 024 événements publiés dans l'agenda (dates, gratuité,
  réservation) ; les 33 153 événements `review_dates`, les 1 535 périodes trop
  longues et les 2 dates aberrantes attendent une vérification.
- Tester la disponibilité et le rendu des URLs d'images ; quatre URLs ont été
  exercées, le proxy n'a pas été exercé sur les 149 637 URLs du paquet.
- Vérifier les obligations ODbL pour les événements Paris avant toute
  réutilisation de la base dérivée.
- Vérifier les coordonnées, horaires et tarifs auprès des producteurs : ce sont
  des données déclaratives, pas des garanties.
- Le déploiement Vercel n'a pas été effectué. Aucun changement de CSP n'est
  nécessaire : les images passent par `/api/media`, déjà en `'self'`.
