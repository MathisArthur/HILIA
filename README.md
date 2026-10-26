# HILIA — rendre le loisir accessible à tous

Site public : <https://www.hilia.fr/>

HILIA référence des lieux de loisirs en France et présente leurs informations
d'accessibilité (stationnement, cheminement, entrée, accueil, sanitaires) ainsi
que les qualifications déclarées par les prestataires.

## Comment c'est construit

Site statique, **sans étape de build** : les pages sont dans le dépôt telles
quelles. Les deux fonctions de `api/` sont compilées par Vercel au déploiement
(rien à lancer localement). Chaîne : **GitHub → Vercel (statique + fonctions) →
Supabase**.

| Élément | Rôle |
| --- | --- |
| `index.html` | La structure des pages (HTML seul, ~50 Ko). |
| `styles.css` | Toute la feuille de style (~56 Ko). |
| `app.js` | Toute l'application : chargement des données, recherche, filtres, carte, fiches, comptes, contributions, routeur d'URL (~170 Ko). |
| `data/places.json` | Jeu de données compact des fiches approuvées, **généré** (voir plus bas) et servi par le CDN. |
| `data/communes.json` | Liste de secours des communes (le jeu de données la fournit déjà). |
| `api/place.js` | Fonction qui sert une fiche (`/lieu/<slug>`) avec ses métadonnées de partage. |
| `api/og.js` | Fonction qui dessine l'image d'aperçu d'une fiche (1200 × 630). |
| `api/_lib/` | Logique partagée : lecture d'une fiche, métadonnées, carte d'aperçu. |
| `scripts/build-dataset.mjs` | Régénère `data/places.json` **et** les sitemaps. |
| `scripts/dev-server.mjs` | Serveur local qui rejoue les en-têtes, les réécritures et les fonctions de `vercel.json`. |
| `scripts/preview-card.mjs` | Génère des exemples de cartes de partage, sans déployer. |
| `vercel.json` | Réécritures d'URL, en-têtes de sécurité (CSP, nosniff, frame-ancestors…) et règles de cache. |
| `404.html` | Page « introuvable » aux couleurs du site. |
| `robots.txt`, `sitemap.xml` | Directives d'exploration ; `sitemap.xml` est un index vers `sitemap-pages.xml` et `sitemap-lieux-*.xml`. |
| Supabase | Base de données, comptes et contributions (appelés directement depuis le navigateur). |

Le HTML, le CSS et le JavaScript sont séparés : une modification du contenu ne
réinvalide plus 270 Ko de code, et chaque fichier évolue sans les autres. Aucun
outil n'est nécessaire pour éditer ou publier le site.

Aucune clé secrète n'est présente : seule la clé **publishable** de Supabase est
dans `app.js`, et ce sont les politiques RLS qui font autorité. Les permissions
vérifiées dans le navigateur (rôles, administration, modération) ne sont qu'un
confort d'interface.

## URL

Une page = une adresse. Les réécritures de `vercel.json` renvoient toutes ces
adresses vers `index.html`, et `app.js` affiche la bonne vue.

| Adresse | Vue |
| --- | --- |
| `/` | Exploration (recherche, filtres, liste, carte) |
| `/lieu/<slug>` | Fiche d'un lieu (ex. `/lieu/piscine-a-serent-48171`) |
| `/a-propos`, `/faq`, `/prestataires`, `/mon-profil` | Rubriques |
| `/mentions-legales`, `/confidentialite`, `/cgu`, `/cookies`, `/contact`, `/accessibilite`, `/plan-du-site` | Pages légales et d'information |

Pour ajouter une rubrique : créer sa `<section class="site-page" data-page="…">`
dans `index.html`, l'ajouter à `PAGE_META` **et** à `PAGE_PATHS` dans `app.js`,
puis ajouter la ligne correspondante dans les `rewrites` de `vercel.json` et dans
`PAGES` de `scripts/build-dataset.mjs` (pour le sitemap).

Les anciens liens `#lieu/…` et `#faq` restent acceptés : ils sont convertis en
adresse propre à l'ouverture.

## Aperçu de partage d'une fiche

Les robots de Facebook, WhatsApp, LinkedIn ou Slack **ne lisent pas le
JavaScript** : sans intervention serveur, toutes les fiches partageraient le même
titre et la même image. Deux fonctions s'en chargent :

1. `vercel.json` réécrit `/lieu/:slug` vers `/api/place`, qui récupère
   `index.html` et n'y remplace que le `<head>` (titre, description, URL
   canonique, `og:*`, données structurées). Le corps de la page reste servi tel
   quel : l'application prend le relais dans le navigateur.
2. `og:image` pointe vers `/api/og?s=<slug>`, qui dessine une carte 1200 × 630
   (nom du lieu, commune, catégorie, trois critères d'accessibilité) avec
   `@vercel/og`. Si la fiche est introuvable, l'image générique du site est
   renvoyée : jamais d'aperçu cassé.

Les URL canoniques utilisent toujours `https://www.hilia.fr`, y compris depuis
une préversion `*.vercel.app` : pas de doublons dans les moteurs de recherche.

Pour vérifier le visuel sans déployer (même moteur que `@vercel/og`) :

```bash
npm i --no-save satori @resvg/resvg-js
node scripts/preview-card.mjs   # images dans og-preview/, non versionnées
```

À contrôler après le premier déploiement : ouvrir une fiche et vérifier que
l'en-tête `Content-Security-Policy` est bien appliqué à la réponse de la fonction
(les règles `headers` de `vercel.json` s'appliquent au chemin demandé).

## Régénérer les données et le sitemap

Le site ne télécharge pas les 54 000 fiches depuis Supabase à chaque visite : il
lit `data/places.json`, un fichier statique mis en cache par le CDN.

**Après chaque import ou modification en masse des fiches**, relancer :

```bash
node scripts/build-dataset.mjs
```

Le script lit `hilia_places` (fiches `approved`) avec la clé publique, réécrit
`data/places.json` puis les trois fichiers de sitemap, et affiche les tailles. Il
faut ensuite committer les fichiers modifiés pour que Vercel les déploie :

```bash
git add data/places.json sitemap*.xml
git commit -m "Régénérer les données et le sitemap"
git push
```

Bon à savoir :

- Le script refuse d'écrire si aucune fiche n'est récupérée (pas d'écrasement par un fichier vide).
- Les colonnes publiées sont celles de `BASE_COLS` dans `app.js` : si vous ajoutez
  une colonne au site, elle est prise en compte automatiquement.
- **Le slug des fiches est calculé deux fois** : par `makePlaceSlug` dans `app.js`
  et par `placeSlug` dans `scripts/build-dataset.mjs` (pour le sitemap). Les deux
  algorithmes doivent rester identiques, sinon le sitemap annoncerait des adresses
  inexistantes.
- Si `data/places.json` est absent ou illisible, le site **bascule tout seul** sur
  l'ancienne lecture paginée de Supabase (plus lente, mais fonctionnelle).
- Les contributions (avis, suggestions, modifications de fiche, lieux ajoutés à la
  main, familles d'activités) ne passent **jamais** par ce fichier : elles restent
  lues en direct dans Supabase.

## Ce que fait l'application

- Recherche plein texte (nom, adresse, commune, code postal), filtres par famille
  d'activités et par critères d'accessibilité, tri, pagination accessible.
- Carte (Leaflet + fond vectoriel MapLibre/OpenFreeMap) avec la liste comme
  équivalent accessible.
- Fiche détaillée : accessibilité, qualification prestataire, avis, lien de partage.
  Chaque fiche a son adresse, son titre, sa description, sa canonique et ses
  données structurées (`LocalBusiness`), mis à jour par le routeur.
- Comptes Supabase : inscription, connexion, mot de passe oublié, réinitialisation.
- Rôles : utilisateur, utilisateur certifié (proposer un lieu), admin (valider,
  refuser, modifier, modérer).
- Formulaire prestataire de 28 questions (dépôt de photos dans le bucket
  `provider-visuals`), traité par un administrateur.
- Réglages d'accessibilité mémorisés dans le navigateur (thème, taille du texte,
  interlignage, police, contraste des liens) et description audio des fiches.

## À personnaliser avant la mise en ligne

Les pages légales sont rédigées et complètes, mais **certaines données
d'identification sont fictives** et doivent être remplacées par les vraies
(mentions légales, section « Éditeur du site ») :

- siège social : 24 boulevard Voltaire, 75011 Paris ;
- RCS Paris 912 345 678, SIRET 912 345 678 00019 ;
- TVA intracommunautaire FR 32 912345678.

À vérifier également : l'adresse de contact (toutes les pages utilisent
`contact@hilia.fr`), la date de la déclaration d'accessibilité, et le fait que
l'audit RGAA annoncé n'a pas encore eu lieu (la page l'indique honnêtement en
« non conforme »).

## Points ouverts

### Données

- L'ancienne ligne de `hilia_place_edits` enregistrée avec `place_id = '54351'`
  (pointait vers une position de liste, plus aucune fiche) peut être supprimée :
  `delete from hilia_place_edits where place_id = '54351';`
- Une centaine de noms importés contiennent des espaces doubles, et quelques-uns
  commencent par un tiret ou un caractère invisible. Les caractères invisibles et
  les espaces superflus sont nettoyés à l'affichage ; le reste vient de la source.
- Le niveau « qualification prestataire » n'est renseigné que pour 2 fiches.

### Images

- L'image de partage par défaut (`og-image.png`, 1200 × 630) et le jeu d'icônes
  (favicon, icône Apple, icônes du manifeste) sont fournis et aux bonnes dimensions.
- Chaque fiche a désormais son aperçu de partage, généré par `/api/og`.
- Chaque famille d'activités a son illustration SVG dans les cartes et les fiches.
- **Aucune photo de lieu n'existe** dans la base : les fiches n'ont pas d'image
  réelle. Les photos transmises par les prestataires sont dans un bucket privé,
  visibles seulement des administrateurs.

### Recherche

La recherche s'effectue encore dans le navigateur sur l'ensemble du jeu de
données (environ 2,6 Mo compressés, une requête). Au-delà de quelques dizaines de
milliers de fiches, une recherche côté serveur (fonction SQL + pagination)
deviendra préférable.

## Tester en local

```bash
npm install        # une seule fois : dépendance @vercel/og (aperçus)
node scripts/dev-server.mjs
```

Le site est servi sur <http://127.0.0.1:8787> avec **les en-têtes, les réécritures
et les fonctions de `vercel.json`**. C'est le seul moyen de voir le site tel qu'il
est publié (CSP comprise) : la moindre violation de CSP apparaît dans la console
du navigateur, et il ne doit y avoir aucune erreur.

- `/lieu/<slug>` passe par `/api/place` comme en production : le titre et
  l'`og:image` de la fiche sont bien ceux de la fiche.
- `/api/og` ne peut pas dessiner en local (`@vercel/og` dépend de modules
  WebAssembly fournis par Vercel) : l'image générique est servie à la place. Pour
  voir une carte réelle, utiliser `scripts/preview-card.mjs`.

`npx vercel dev` fonctionne aussi, mais demande une connexion à Vercel.
