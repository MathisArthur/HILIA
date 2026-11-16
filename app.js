/* HILIA - application : tout le JavaScript du site, chargé en fin de page. */
  // Le jeu de données des fiches (une seule requête, servie par le CDN) part dès
  // l'analyse de l'en-tête sur les pages qui en ont besoin : l'exploration et une
  // fiche. Les pages de contenu (/faq, /mentions-legales, ...) n'affichent aucune
  // fiche : leurs 2,9 Mo compressés n'y sont pas téléchargés. Une recherche ou
  // un clic vers l'exploration les charge à la demande (voir ensurePlaces).
  var CONTENT_ONLY_PATHS = ['/agenda','/a-propos','/faq','/mentions-legales','/confidentialite','/cgu','/cookies','/contact','/accessibilite','/plan-du-site'];
  var BOOT_PATH = String(location.pathname||'/').replace(/\/index\.html$/,'/').replace(/\/+$/,'') || '/';
  var DEFER_PLACES = CONTENT_ONLY_PATHS.indexOf(BOOT_PATH) !== -1;
  window.__hiliaDataset = DEFER_PLACES ? Promise.resolve(null) : fetch('/data/places.json', {cache:'force-cache'})
    .then(function(r){ return r.ok ? r.json() : null; })
    .catch(function(){ return null; });
  // Fiches retirées après contrôle qualité. La liste est chargée avant le
  // catalogue pour qu'une erreur corrigée ne réapparaisse pas à l'écran.
  var placeExclusionsPromise = null;
  var placeExclusionIds = new Set();
  function loadPlaceExclusions(){
    if(placeExclusionsPromise) return placeExclusionsPromise;
    placeExclusionsPromise = fetch('/data/place-exclusions.json', {cache:'no-cache'})
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(doc){
        (doc && Array.isArray(doc.entries) ? doc.entries : []).forEach(function(entry){
          if(entry && entry.id != null) placeExclusionIds.add(String(entry.id));
        });
        return placeExclusionIds;
      })
      .catch(function(){ return placeExclusionIds; });
    return placeExclusionsPromise;
  }

(async function(){
  "use strict";
  // Supabase : clé publique uniquement. Les autorisations restent contrôlées par les politiques RLS.
  // Détecter le lien de récupération AVANT que le SDK Supabase ne nettoie l'URL.
  var initialPasswordRecoveryLink = /(?:[?&#])type=recovery(?:[&#]|$)/i.test(window.location.search + '&' + window.location.hash);
  // Le site déployé garde ses valeurs par défaut. Le serveur de test local
  // injecte window.HILIA_SUPABASE_CONFIG depuis SUPABASE_URL / SUPABASE_KEY
  // pour cibler le projet Supabase de test, sans modifier la production.
  var runtimeSupabase = window.HILIA_SUPABASE_CONFIG || null;
  var runtimeUrl = runtimeSupabase && typeof runtimeSupabase.url === 'string'
    ? runtimeSupabase.url.replace(/\/+$/, '') : '';
  var SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co$/i.test(runtimeUrl)
    ? runtimeUrl : 'https://lokplzdkvzilsuuqflsk.supabase.co';
  var SUPABASE_ANON_KEY = runtimeSupabase && typeof runtimeSupabase.key === 'string' && runtimeSupabase.key
    ? runtimeSupabase.key : 'sb_publishable_86IcrAhzRoOkZZn-KGKe6A_6-_FO0B0';
  if(runtimeSupabase) console.info('HILIA : Supabase local ciblé sur ' + SUPABASE_URL);
  // Client Supabase (SDK v2 chargé dans <head>). Session persistée + rafraîchissement automatique du jeton.
  var supabaseClient = null;
  try{
    if(window.supabase && window.supabase.createClient){
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
      });
    }else{
      console.error('HILIA : le SDK Supabase ne s’est pas chargé (réseau ou bloqueur de contenu).');
    }
  }catch(err){ console.error('HILIA : initialisation Supabase impossible', err); }

  // ---------- Chargement des lieux depuis la table unique hilia_places ----------
  var BASE_COLS=['name','address','cp','commune','activity','site','lat','lon','transport','stationnement','stationnement_pmr','stationnement_ext','stationnement_ext_pmr','chemin_plain_pied','chemin_terrain_stable','chemin_marches','chemin_reperage','chemin_main_courante','chemin_rampe','chemin_bande_guidage','entree_reperable','entree_plain_pied','entree_ascenseur','entree_marches','entree_rampe','entree_dispositif_appel','entree_balise_sonore','entree_aide_humaine','entree_largeur','entree_specifique_pmr','accueil_personnel','accueil_audiodescr','accueil_equip_malent','accueil_plain_pied','accueil_signaletique','sanitaires_dispo','sanitaires_pmr','labels','familles','conformite'];
  function baseBanner(text,isError){
    var b=document.getElementById('baseLoading');
    if(!b){ b=document.createElement('div'); b.id='baseLoading'; b.setAttribute('role','status'); b.setAttribute('aria-live','polite'); b.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px 14px;text-align:center;font:700 .85rem "Archivo",sans-serif;background:#064647;color:#fff;'; document.body.appendChild(b); }
    b.textContent=text; if(isError) b.style.background='#8A1C1C'; return b;
  }
  // Chargement des lieux. Deux sources, dans cet ordre :
  //  1. data/places.json - jeu de données compact des fiches approuvées, généré par
  //     scripts/build-dataset.mjs et servi par le CDN : une seule requête, mise en
  //     cache, aucune charge sur Supabase. À régénérer après un import en masse.
  //  2. Repli : lecture paginée de la table hilia_places, si le fichier est absent
  //     (juste après un premier déploiement, par exemple).
  async function loadPlacesFromDataset(raw){
    var ds=await window.__hiliaDataset;
    if(!ds){
      // Page de contenu : le fichier n'était pas préchargé, on le demande maintenant
      // (ou le préchargement a échoué : une seconde tentative ne coûte rien).
      try{ var resp=await fetch('/data/places.json',{cache:'force-cache'}); ds=resp.ok?await resp.json():null; }catch(err){ ds=null; }
    }
    if(!ds) throw new Error('data/places.json : téléchargement impossible');
    if(!Array.isArray(ds.rows) || !ds.rows.length) throw new Error('data/places.json : format inattendu');
    var actRemap=null;
    if(Array.isArray(ds.activites) && ds.activites.length){
      var seenAct=Object.create(null);
      actRemap=[];
      raw.activites=[];
      ds.activites.forEach(function(a,i){
        var label=canonicalActivityName(a);
        var key=normalize(label);
        var idx=seenAct[key];
        if(idx===undefined){ idx=raw.activites.length; seenAct[key]=idx; raw.activites.push(label); }
        actRemap[i]=idx;
      });
    }
    if(Array.isArray(ds.communes)) raw.communes=ds.communes.slice();
    var accessById=ds.access||{}, qualifById=ds.qualif||{};
    raw.data=ds.rows.map(function(row){
      // row = [id, ...40 valeurs] ; commune et activité sont déjà des index.
      var x=new Array(BASE_COLS.length), i;
      for(i=0;i<BASE_COLS.length;i++){ var v=row[i+1]; x[i]=v==null?'':v; }
      var id=row[0];
      x._hiliaPlaceId=id;
      var extra=accessById[id];
      if(extra && typeof extra==='object'){ if(extra._unknown) x._accessUnknown=true; Object.keys(extra).forEach(function(k){ var ki=Number(k); if(ki>=8&&ki<=36&&x[ki]==='') x[ki]=extra[k]; }); }
      x._hiliaQualif=qualifById[id]||null;
      if(actRemap && x[4]!=='' && actRemap[Number(x[4])]!=null) x[4]=actRemap[Number(x[4])];
      return x;
    });
    await loadPlaceExclusions();
    raw.data = raw.data.filter(function(row){ return !placeExclusionIds.has(String(row._hiliaPlaceId)); });
    return true;
  }
  async function loadPlacesFromSupabase(raw){
    if(!supabaseClient) throw new Error('SDK Supabase indisponible');
    var selectCols='id,'+BASE_COLS.join(',')+',access,qualif,status,approved_at,created_at,data_origin,updated_at';
    var head=await supabaseClient.from('hilia_places').select('id',{count:'exact',head:true}).eq('status','approved');
    if(head.error) throw head.error;
    var total=head.count||0;
    if(!total){ raw.data=[]; return true; }
    var pageSize=1000, pages=Math.ceil(total/pageSize), nextPage=0, failed=null, donePages=0, rows=new Array(total);
    var worker=async function(){
      while(!failed){
        var pg=nextPage++; if(pg>=pages) return;
        var from=pg*pageSize, to=Math.min(from+pageSize-1,total-1);
        var result=await supabaseClient.from('hilia_places').select(selectCols).eq('status','approved').order('id',{ascending:true}).range(from,to);
        if(result.error){ failed=result.error; return; }
        if(!result.data || !result.data.length) return;
        for(var j=0;j<result.data.length;j++) rows[from+j]=result.data[j];
        donePages++; baseBanner('Chargement des lieux… '+Math.round(donePages*100/pages)+' %');
      }
    };
    await Promise.all([worker(),worker(),worker(),worker()]);
    if(failed) throw failed;
    rows=rows.filter(Boolean);
    var cIdx=new Map(raw.communes.map(function(n,i){return [n,i];})), aIdx=new Map(raw.activites.map(function(n,i){return [n,i];}));
    raw.data=rows.map(function(o){
      var x=BASE_COLS.map(function(c){return o[c]==null?'':o[c];});
      var ci=cIdx.get(o.commune||''); if(ci===undefined){ci=raw.communes.length;raw.communes.push(o.commune||'');cIdx.set(o.commune||'',ci);} x[3]=ci;
      var activityName=canonicalActivityName(o.activity);
      var ai=aIdx.get(activityName); if(ai===undefined){ai=raw.activites.length;raw.activites.push(activityName);aIdx.set(activityName,ai);} x[4]=ai;
      // Les colonnes détaillées sont prioritaires ; access/qualif restent prises en charge pour les fiches ajoutées manuellement.
      if(o.access && typeof o.access==='object'){ if(o.access._unknown) x._accessUnknown=true; Object.keys(o.access).forEach(function(k){var ki=Number(k);if(ki>=8&&ki<=36&&x[ki]==='')x[ki]=o.access[k];}); }
      x._hiliaPlaceId=o.id;
      x._hiliaQualif=o.qualif||null;
      return x;
    });
    await loadPlaceExclusions();
    raw.data = raw.data.filter(function(row){ return !placeExclusionIds.has(String(row._hiliaPlaceId)); });
    return true;
  }
  async function loadBasePlaces(raw){
    function finish(ok){ var b=document.getElementById('baseLoading'); if(ok){ if(b) b.remove(); return true; } baseBanner('Impossible de charger les lieux depuis HILIA. Vérifiez votre connexion, puis rechargez la page.',true); return false; }
    if(DEFER_PLACES){
      var deferBanner=document.getElementById('baseLoading'); if(deferBanner) deferBanner.remove();
      return true;
    }
    baseBanner('Chargement des lieux…');
    try{
      await loadPlacesFromDataset(raw);
      return finish(true);
    }catch(err){
      console.warn('HILIA : jeu de données statique indisponible, repli sur Supabase.',err);
    }
    try{
      await loadPlacesFromSupabase(raw);
      return finish(true);
    }catch(err2){
      console.warn('Chargement des lieux impossible',err2);
      return finish(false);
    }
  }
  // Les communes ne sont plus embarquées dans la page (13 000 noms ≈ 170 Ko) : elles se construisent à partir des lieux
  // reçus de Supabase, et /data/communes.json est chargé à la demande (voir loadCommunes).
  var raw = {activites:["Sports et loisirs","Salle de remise en forme","Salle multisports","Bowling","Salle de jeux","Loisirs créatifs","Cinéma","Centre culturel","Gymnase","Salle des fêtes","Bibliothèque médiathèque","Conservatoire et école de musique","Théâtre","Piscine, centre aquatique","Musée","Office de tourisme","Lieu de visite","Stade","Complexe sportif","Centre de vacances","Parc d’attraction","Accrobranche","Salle de spectacle","Casino","Village de vacances","Plage, zone de baignade","Salle de combat","Club de sport","Centre équestre","Equipement sportif","Centre de loisirs","Tennis","Art, centre d'art","Monument historique","Evénement culturel","Randonnées pédestres ou vélos","Information Touristique","Salle de danse","Auditorium et salle de conférence","Salle de concert","Discothèque","Galerie d'art","Musique","Parc","Espace vert et naturel","Parc des expositions","Jardin botanique et/ou zoologique","Circuit sportif deux roues / voiture","Château","Cyclisme","Jeux vidéo","Oenotourisme","Patinoire","Ecole de danse","Boulodrome","Plateaux et terrains de jeux extérieurs","Opéra","Athlétisme","Observatoire, astronomie","Arène","Skatepark","Aquarium","Karaoké","Refuge animalier","Ecole de ski et snowboard"], communes:[], data:[]};
  await loadBasePlaces(raw);
  var ACTIVITES = raw.activites.slice();
  var COMMUNES = raw.communes;
  var DATA = raw.data;

  // Prototype storage keys. Production permissions/data must be enforced server-side.
  var PROFILE_KEY = 'halia_profile_v1';
  var PENDING_PLACES_KEY = 'halia_pending_places_v1';
  var APPROVED_PLACES_KEY = 'halia_custom_places_v1';
  var EDITS_KEY = 'halia_place_edits_v1';
  var SUGGESTIONS_KEY = 'halia_suggestions_v1';
  var CUSTOM_ACTIVITIES_KEY = 'halia_custom_activities_v1';

  function getCustomActivitiesEarly(){
    try{
      var v=JSON.parse(localStorage.getItem(CUSTOM_ACTIVITIES_KEY)||'[]');
      return Array.isArray(v)?v.filter(function(a){return typeof a==='string' && a.trim();}).map(function(a){return a.trim();}):[];
    }catch(e){ return []; }
  }
  getCustomActivitiesEarly().forEach(function(a){ if(ACTIVITES.indexOf(a)<0) ACTIVITES.push(a); });

  var F = {
    NOM:0, ADR:1, CP:2, COM:3, ACT:4, SITE:5, LAT:6, LON:7,
    TRANSPORT:8, STATIONNEMENT:9, STATIONNEMENT_PMR:10, STATIONNEMENT_EXT:11, STATIONNEMENT_EXT_PMR:12,
    CHEMIN_PLAIN_PIED:13, CHEMIN_TERRAIN_STABLE:14, CHEMIN_MARCHES:15, CHEMIN_REPERAGE:16,
    CHEMIN_MAIN_COURANTE:17, CHEMIN_RAMPE:18, CHEMIN_BANDE_GUIDAGE:19,
    ENTREE_REPERABLE:20, ENTREE_PLAIN_PIED:21, ENTREE_ASCENSEUR:22, ENTREE_MARCHES:23,
    ENTREE_RAMPE:24, ENTREE_DISPOSITIF_APPEL:25, ENTREE_BALISE_SONORE:26, ENTREE_AIDE_HUMAINE:27,
    ENTREE_LARGEUR:28, ENTREE_SPECIFIQUE_PMR:29,
    ACCUEIL_PERSONNEL:30, ACCUEIL_AUDIODESCR:31, ACCUEIL_EQUIP_MALENT:32, ACCUEIL_PLAIN_PIED:33, ACCUEIL_SIGNALETIQUE:34,
    SANITAIRES_DISPO:35, SANITAIRES_PMR:36, LABELS:37, FAMILLES:38, CONFORMITE:39,
    QUALIF:40, Q_FAUTEUIL:41, Q_FAUT_AUTONOME:42, Q_EFFORT_FAIBLE:43, Q_SIEGES:44, Q_ESPACE_CALME:45, Q_PAS_FLASH:46, Q_PAUSE:47, Q_CRENEAUX:48, Q_FALC:49, Q_RESA_SANS_APPEL:50, Q_BIM:51, Q_AUDIODESC:52, Q_TARIF_AVANT:53, Q_GRATUIT_ACCOMP:54
  };

  // Noms et communes : retirer les caractères invisibles laissés par l’import
  // (emoji tronqués, séparateurs Unicode) et les espaces multiples, qui
  // polluaient l’affichage, les titres de page et les données structurées.
  function cleanLabels(){
    var INVISIBLE=/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;
    // Convention d’affichage du site : un tiret simple, jamais de tiret cadratin.
    var EM_DASH=/\u2014/g;
    function tidy(v){ return String(v==null?'':v).replace(INVISIBLE,'').replace(/\s+/g,' ').trim().replace(EM_DASH,'-'); }
    for(var i=0;i<DATA.length;i++){ var r=DATA[i]; if(r) r[F.NOM]=tidy(r[F.NOM])||'Lieu sans nom'; }
    for(var c=0;c<COMMUNES.length;c++){ var nom=tidy(COMMUNES[c]); if(nom) COMMUNES[c]=nom; }
  }
  cleanLabels();

  function buildCustomRows(){
    var out=[];
    getApprovedPlaces().forEach(function(p){
      // Évite les doublons si un ancien cache navigateur contient encore les lieux importés.
      if(p && p.id && DATA.some(function(existing){return String(existing._hiliaPlaceId||'')===String(p.id);})) return;
      var actIdx=ACTIVITES.indexOf(canonicalActivityName(p.activity)); if(actIdx<0) return;
      var commune=(p.commune||'').trim()||'Commune à préciser';
      var comIdx=COMMUNES.indexOf(commune); if(comIdx<0){ COMMUNES.push(commune); comIdx=COMMUNES.length-1; }
      var row=new Array(40).fill(null);
      // Conserver l’identifiant Supabase sur la ligne affichée : les actions Admin
      // ne doivent pas dépendre d’une comparaison exacte des champs de la fiche.
      row._hiliaPlaceId=p.id||null;
      row[F.NOM]=p.name||'Lieu sans nom'; row[F.ADR]=p.address||''; row[F.CP]=p.cp||''; row[F.COM]=comIdx; row[F.ACT]=actIdx; row[F.SITE]=p.site||'';
      if(p.access && p.access._unknown) row._accessUnknown=true;
      row[F.LAT]=p.lat!=='' && p.lat!=null ? Number(p.lat) : null; row[F.LON]=p.lon!=='' && p.lon!=null ? Number(p.lon) : null;
      if(p.access && typeof p.access==='object') Object.keys(p.access).forEach(function(k){ var ki=Number(k); if(ki>=8 && ki<=36) row[ki]=p.access[k]; });
      if(p.qualif && typeof p.qualif==='object') applyQualif(row,p.qualif);
      out.push(row);
    });
    return out;
  }
  DATA = DATA.concat(buildCustomRows());

  // Les fiches importées portent leur qualification prestataire dans
  // `_hiliaQualif`, mais les colonnes de filtrage (Q_*) n'étaient remplies que
  // pour les fiches créées dans ce navigateur. Résultat : les critères de
  // qualification - tarif réduit, confort sensoriel, communication, pratique de
  // l'activité - ne trouvaient aucune fiche importée, alors que la fiche en
  // affichait bien les informations.
  for(var qr=0; qr<DATA.length; qr++){
    var rowQ = DATA[qr];
    if(rowQ && rowQ._hiliaQualif && rowQ[F.QUALIF] == null) applyQualif(rowQ, rowQ._hiliaQualif);
  }

  // ---------- Rattachement des contributions à l'identifiant réel des fiches ----------
  // Avis, suggestions et modifications étaient enregistrés avec la *position* de la
  // fiche dans la liste : le moindre import, ajout ou suppression décalait tous les
  // indices et rattachait la contribution au mauvais lieu. On utilise désormais
  // l'identifiant Supabase, présent sur chaque ligne chargée (_hiliaPlaceId).
  var placeIndexById = new Map();
  function indexPlacesById(){
    placeIndexById = new Map();
    for(var i=0;i<DATA.length;i++){ var r=DATA[i]; if(r && r._hiliaPlaceId!=null) placeIndexById.set(String(r._hiliaPlaceId), i); }
  }
  function placeRef(di){ var r=DATA[di]; return r && r._hiliaPlaceId!=null ? String(r._hiliaPlaceId) : ''; }
  function indexFromPlaceRef(ref){
    if(ref==null || ref==='') return -1;
    return placeIndexById.has(String(ref)) ? placeIndexById.get(String(ref)) : -1;
  }
  indexPlacesById();

  function applySavedEdits(){
    var edits=getEdits();
    Object.keys(edits).forEach(function(ref){
      var di=indexFromPlaceRef(ref), e=edits[ref], row=DATA[di]; if(di<0 || !row || !e) return;
      if(e.name!=null) row[F.NOM]=e.name;
      if(e.address!=null) row[F.ADR]=e.address;
      if(e.cp!=null) row[F.CP]=e.cp;
      if(e.activity){ var ai=ACTIVITES.indexOf(e.activity); if(ai>=0) row[F.ACT]=ai; }
      if(e.site!=null) row[F.SITE]=e.site;
      if(e.access && typeof e.access==='object') Object.keys(e.access).forEach(function(k){ var ki=Number(k); if(ki>=8 && ki<=36) row[ki]=e.access[k]; });
      if(e.commune){ var ci=COMMUNES.indexOf(e.commune); if(ci<0){COMMUNES.push(e.commune);ci=COMMUNES.length-1;} row[F.COM]=ci; }
    });
  }
  applySavedEdits();

  function isTrue(v){ return v === 1 || v === true || v === "True"; }
  function isFalse(v){ return v === 0 || v === false || v === "False"; }
  function safeExternalUrl(value){
    try{
      var u=new URL(String(value||'').trim(),window.location.href);
      return (u.protocol==='http:' || u.protocol==='https:') ? u.href : '';
    }catch(e){ return ''; }
  }
  function normalize(s){ if(!s) return ""; return s.toString().replace(/[\u2010-\u2015\u2212]/g,' ').replace(/\s+/g,' ').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
  // Catégorie historique mal encodée (« Th��âtre ») : même libellé, sans
  // toucher aux index déjà stockés dans le catalogue.
  function canonicalActivityName(value){ var label=String(value||'').replace(/\uFFFD/g,'').trim(); var key=normalize(label); return (key==='theatre' || /^th.*atre$/.test(key) || /^th/i.test(key) && /atre$/.test(key)) ? 'Théâtre' : label; }

  // ---------- Category -> illustration template mapping ----------
  var CATEGORY_TEMPLATE = {
    "Salle de remise en forme":"sport_salle","Salle multisports":"sport_salle","Gymnase":"sport_salle",
    "Salle de combat":"sport_salle","Club de sport":"sport_salle","Equipement sportif":"sport_salle",
    "Complexe sportif":"sport_salle","Salle de danse":"sport_salle","Ecole de danse":"sport_salle",
    "Boulodrome":"sport_salle","Athlétisme":"sport_salle",
    "Stade":"stade_exterieur","Tennis":"stade_exterieur","Circuit sportif deux roues / voiture":"stade_exterieur",
    "Cyclisme":"stade_exterieur","Skatepark":"stade_exterieur","Plateaux et terrains de jeux extérieurs":"stade_exterieur","Arène":"stade_exterieur",
    "Piscine, centre aquatique":"piscine","Plage, zone de baignade":"piscine","Aquarium":"piscine",
    "Bibliothèque médiathèque":"bibliotheque","Conservatoire et école de musique":"bibliotheque",
    "Musée":"musee_art","Art, centre d'art":"musee_art","Galerie d'art":"musee_art","Monument historique":"musee_art",
    "Château":"musee_art","Observatoire, astronomie":"musee_art",
    "Théâtre":"spectacle","Salle de spectacle":"spectacle","Cinéma":"spectacle","Salle de concert":"spectacle",
    "Auditorium et salle de conférence":"spectacle","Discothèque":"spectacle","Casino":"spectacle","Musique":"spectacle",
    "Opéra":"spectacle","Karaoké":"spectacle","Evénement culturel":"spectacle",
    "Parc":"nature","Espace vert et naturel":"nature","Jardin botanique et/ou zoologique":"nature",
    "Refuge animalier":"nature","Randonnées pédestres ou vélos":"nature","Accrobranche":"nature",
    "Office de tourisme":"tourisme","Lieu de visite":"tourisme","Information Touristique":"tourisme",
    "Oenotourisme":"tourisme","Parc d’attraction":"tourisme","Parc des expositions":"tourisme",
    "Loisirs créatifs":"loisirs_creatifs","Jeux vidéo":"loisirs_creatifs","Salle de jeux":"loisirs_creatifs","Bowling":"loisirs_creatifs",
    "Salle des fêtes":"convivialite","Centre culturel":"convivialite","Centre de loisirs":"convivialite",
    "Centre de vacances":"convivialite","Village de vacances":"convivialite",
    "Centre équestre":"montagne","Ecole de ski et snowboard":"montagne","Patinoire":"montagne",
    "Sports et loisirs":"general"
  };
  function getTemplate(name){ return CATEGORY_TEMPLATE[name] || "general"; }

  var TEMPLATE_COLOR = {
    sport_salle:"#006D77", stade_exterieur:"#D1495B", piscine:"#0077B6", bibliotheque:"#6A4C93",
    musee_art:"#8F5D00", spectacle:"#C2185B", nature:"#2A7F3F", tourisme:"#5B5F97",
    loisirs_creatifs:"#E76F00", convivialite:"#00897B", montagne:"#5C677D", general:"#344054"
  };
  var TEMPLATE_LABEL = {
    sport_salle:"Sport en salle", stade_exterieur:"Sport extérieur & stade", piscine:"Piscine & baignade",
    bibliotheque:"Bibliothèque & musique", musee_art:"Musée & patrimoine", spectacle:"Spectacle & sortie",
    nature:"Nature & parcs", tourisme:"Tourisme", loisirs_creatifs:"Loisirs créatifs & jeux",
    convivialite:"Convivialité & fêtes", montagne:"Plein air & montagne", general:"Général"
  };

  function contrastRatio(hexA, hexB){
    function lum(h){ var rgb=hexToRgb(h).map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}); return 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2]; }
    var a=lum(hexA),b=lum(hexB); return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  }
  function auditConfiguredContrastPalette(){
    var pairs=[['teal sur blanc','#064647','#FFFFFF'],['texte principal sur crème','#183A3A','#F8F3E8'],['texte secondaire sur crème','#566867','#F8F3E8'],['texte blanc sur teal','#FFFFFF','#064647'],['amber ink sur amber','#5A3A00','#FEB31E']];
    return pairs.map(function(p){return {name:p[0],ratio:Number(contrastRatio(p[1],p[2]).toFixed(2))};});
  }
  // TODO : compléter cette vérification avec les couleurs réellement calculées après chaque thème et avec un outil de contraste indépendant avant audit RGAA.
  window.HILIAContrastCheck=auditConfiguredContrastPalette;
  function colorFor(actIdx){ return TEMPLATE_COLOR[getTemplate(ACTIVITES[actIdx])]; }
  function hexToRgb(h){ h=h.replace('#',''); return [parseInt(h.substr(0,2),16),parseInt(h.substr(2,2),16),parseInt(h.substr(4,2),16)]; }
  function relLum(rgb){ var c=rgb.map(function(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]; }
  function contrastText(bg){ var L=relLum(hexToRgb(bg)), dark='#10302F'; var cw=1.05/(L+0.05), cd=(L+0.05)/(relLum(hexToRgb(dark))+0.05); return cw>=cd ? '#FFFFFF' : dark; }
  function rgbToHex(rgb){ return '#'+rgb.map(function(v){ var h=Math.max(0,Math.min(255,Math.round(v))).toString(16); return h.length===1?'0'+h:h; }).join('').toUpperCase(); }
  function tagPalette(bg){
    // Le texte du badge est petit : on garantit 4,5:1, quitte à foncer
    // légèrement la teinte de catégorie pour conserver son repère visuel.
    var text = contrastText(bg);
    if(contrastRatio(bg,text) >= 4.5) return {bg:bg, text:text};
    var rgb = hexToRgb(bg);
    for(var mix=0.05; mix<=0.7; mix+=0.05){
      var candidate = rgbToHex(rgb.map(function(v){ return v*(1-mix); }));
      if(contrastRatio(candidate,'#FFFFFF') >= 4.5) return {bg:candidate, text:'#FFFFFF'};
    }
    return {bg:'#062B28', text:'#FFFFFF'};
  }
  var liveEl=document.getElementById('liveRegion'), liveTimer=null, toastTimer=null;
  var toastEl=document.getElementById('hilToast'), toastText=document.getElementById('hilToastText');
  function hideToast(){ if(toastEl) toastEl.classList.remove('is-visible'); if(toastTimer) clearTimeout(toastTimer); }
  var toastClose=document.getElementById('hilToastClose'); if(toastClose) toastClose.addEventListener('click',hideToast);
  function announce(msg, delay){
    msg=String(msg==null?'':msg).trim(); if(!msg) return;
    if(liveEl){ clearTimeout(liveTimer); liveTimer=setTimeout(function(){ liveEl.textContent=''; setTimeout(function(){ liveEl.textContent=msg; },40); }, delay==null?100:Math.max(0,Math.min(delay,250))); }
    if(toastEl && toastText){
      var kind=/impossible|erreur|échec|échoué|incorrect|invalide|réservée|trop court|minimum|manque|confirmez|vérifiez|ne se charge pas/i.test(msg)?'error':(/réussi|réussie|publié|publiée|enregistré|enregistrée|envoyée|transmise|supprimé|supprimée|retiré|retirée|déconnecté|copié|validé|validée|refusé|refusée|terminée|réinitialisés/i.test(msg)?'success':'info');
      toastEl.dataset.kind=kind; toastText.textContent=msg; toastEl.classList.add('is-visible');
      if(toastTimer) clearTimeout(toastTimer); toastTimer=setTimeout(hideToast,kind==='error'?5000:3500);
    }
  }

  // ---------- Illustration SVGs (one per template, flat & consistent) ----------
  function illustrationSVG(key){
    var bgs = {
      sport_salle:"#E5F0EE", stade_exterieur:"#FFF2CE", piscine:"#E4F3F1", bibliotheque:"#EFEADF",
      musee_art:"#E8EFEC", spectacle:"#EAF3F0", nature:"#E6F0EA", tourisme:"#FFF0C5",
      loisirs_creatifs:"#F8EDDC", convivialite:"#F1EEE2", montagne:"#E8F0EA", general:"#F0EDE4"
    };
    var bg = bgs[key] || "#EFF1F3";
    var c = TEMPLATE_COLOR[key] || "#5B6470";
    var scenes = {
      sport_salle:'<circle cx="60" cy="30" r="10" fill="'+c+'"/><rect x="40" y="46" width="40" height="8" rx="4" fill="'+c+'"/><circle cx="36" cy="50" r="9" fill="'+c+'"/><circle cx="84" cy="50" r="9" fill="'+c+'"/><path d="M150 60l14-26h14l-14 26z" fill="'+c+'" opacity=".85"/>',
      stade_exterieur:'<path d="M20 62c40-30 160-30 200 0" fill="none" stroke="'+c+'" stroke-width="4"/><circle cx="120" cy="30" r="9" fill="'+c+'"/><path d="M60 62V34M60 34h20" fill="none" stroke="'+c+'" stroke-width="4"/><path d="M180 62V34M180 34h-20" fill="none" stroke="'+c+'" stroke-width="4"/>',
      piscine:'<path d="M10 50q15-10 30 0t30 0 30 0 30 0 30 0 30 0" fill="none" stroke="'+c+'" stroke-width="4"/><path d="M10 64q15-10 30 0t30 0 30 0 30 0 30 0 30 0" fill="none" stroke="'+c+'" stroke-width="3" opacity=".6"/><circle cx="185" cy="24" r="12" fill="'+c+'" opacity=".9"/>',
      bibliotheque:'<rect x="30" y="30" width="14" height="34" fill="'+c+'"/><rect x="48" y="22" width="14" height="42" fill="'+c+'" opacity=".85"/><rect x="66" y="34" width="14" height="30" fill="'+c+'" opacity=".7"/><path d="M110 26h60v6H110zM110 40h60v6H110zM110 54h44v6h-44z" fill="'+c+'" opacity=".8"/>',
      musee_art:'<rect x="60" y="20" width="10" height="42" fill="'+c+'"/><rect x="90" y="20" width="10" height="42" fill="'+c+'"/><rect x="120" y="20" width="10" height="42" fill="'+c+'"/><rect x="150" y="20" width="10" height="42" fill="'+c+'"/><path d="M52 20h116v-8H52z" fill="'+c+'"/><path d="M52 62h116v6H52z" fill="'+c+'"/>',
      spectacle:'<path d="M60 16v48M180 16v48" stroke="'+c+'" stroke-width="5"/><path d="M60 16q30 24 0 48M180 16q-30 24 0 48" fill="none" stroke="'+c+'" stroke-width="4"/><circle cx="120" cy="26" r="9" fill="'+c+'"/><path d="M104 50a16 10 0 0032 0z" fill="'+c+'" opacity=".85"/>',
      nature:'<path d="M0 64q60-26 120 0t120 0V70H0z" fill="'+c+'" opacity=".35"/><path d="M110 20l16 28H94z" fill="'+c+'"/><rect x="107" y="46" width="6" height="16" fill="'+c+'"/><path d="M150 30l12 20h-24z" fill="'+c+'" opacity=".8"/>',
      tourisme:'<circle cx="120" cy="40" r="22" fill="none" stroke="'+c+'" stroke-width="4"/><path d="M120 24l7 14-16 4z" fill="'+c+'"/><path d="M60 60h20M160 60h20" stroke="'+c+'" stroke-width="3"/>',
      loisirs_creatifs:'<rect x="70" y="24" width="24" height="24" rx="4" fill="'+c+'"/><circle cx="130" cy="36" r="14" fill="'+c+'" opacity=".85"/><path d="M150 50l14 14M164 50l-14 14" stroke="'+c+'" stroke-width="5" stroke-linecap="round"/>',
      convivialite:'<path d="M40 22l14 20-14 4-14-4z" fill="'+c+'"/><path d="M80 18l14 24-14 4-14-4z" fill="'+c+'" opacity=".85"/><path d="M120 22l14 20-14 4-14-4z" fill="'+c+'"/><path d="M160 18l14 24-14 4-14-4z" fill="'+c+'" opacity=".85"/><path d="M20 46h180" stroke="'+c+'" stroke-width="2"/>',
      montagne:'<path d="M0 62l40-34 30 22 26-30 40 42z" fill="'+c+'" opacity=".8"/><circle cx="188" cy="20" r="10" fill="'+c+'"/>',
      general:'<circle cx="120" cy="38" r="18" fill="'+c+'" opacity=".85"/><path d="M120 20l4 12h12l-10 8 4 12-10-7-10 7 4-12-10-8h12z" fill="#fff" opacity=".9"/>'
    };
    return '<svg aria-hidden="true" focusable="false" viewBox="0 0 240 78" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="240" height="78" fill="'+bg+'"/>'+(scenes[key]||scenes.general)+'</svg>';
  }

  // ---------- Index de recherche et indice d'accessibilité ----------
  // Le tri « accessibilité » ne compte pas les critères indifféremment :
  // il couvre six dimensions pondérées selon leur impact sur une visite.
  // Une dimension compte dès qu'au moins un de ses critères est déclaré.
  var SCORE_FIELDS = [F.TRANSPORT,F.STATIONNEMENT,F.STATIONNEMENT_PMR,F.STATIONNEMENT_EXT,F.STATIONNEMENT_EXT_PMR,
    F.CHEMIN_PLAIN_PIED,F.CHEMIN_TERRAIN_STABLE,F.CHEMIN_REPERAGE,F.CHEMIN_MAIN_COURANTE,F.CHEMIN_RAMPE,F.CHEMIN_BANDE_GUIDAGE,
    F.ENTREE_REPERABLE,F.ENTREE_PLAIN_PIED,F.ENTREE_ASCENSEUR,F.ENTREE_RAMPE,F.ENTREE_DISPOSITIF_APPEL,F.ENTREE_BALISE_SONORE,
    F.ENTREE_AIDE_HUMAINE,F.ENTREE_SPECIFIQUE_PMR,F.ACCUEIL_PERSONNEL,F.ACCUEIL_AUDIODESCR,F.ACCUEIL_EQUIP_MALENT,
    F.ACCUEIL_PLAIN_PIED,F.ACCUEIL_SIGNALETIQUE,F.SANITAIRES_DISPO,F.SANITAIRES_PMR];
  var ACCESS_DIMENSIONS = [
    {label:'Entrée accessible', weight:3, fields:[F.ENTREE_PLAIN_PIED,F.ENTREE_RAMPE,F.ENTREE_ASCENSEUR,F.ENTREE_AIDE_HUMAINE]},
    {label:'Cheminement', weight:2, fields:[F.CHEMIN_PLAIN_PIED,F.CHEMIN_TERRAIN_STABLE,F.CHEMIN_RAMPE]},
    {label:'Sanitaires adaptés', weight:2, fields:[F.SANITAIRES_PMR]},
    {label:'Stationnement adapté', weight:1, fields:[F.STATIONNEMENT_PMR,F.STATIONNEMENT_EXT_PMR]},
    {label:'Accueil', weight:1, fields:[F.ACCUEIL_PERSONNEL,F.ACCUEIL_PLAIN_PIED,F.ACCUEIL_SIGNALETIQUE]},
    {label:'Confort sensoriel', weight:1, fields:[F.ACCUEIL_AUDIODESCR,F.ACCUEIL_EQUIP_MALENT,F.ENTREE_BALISE_SONORE]}
  ];
  // Critères qui pèsent le plus lourd dans une visite réelle. Ils servent
  // seulement à départager deux lieux qui ont le même indice de couverture.
  var ACCESS_ESSENTIAL_FIELDS = [F.ENTREE_PLAIN_PIED,F.ENTREE_RAMPE,F.ENTREE_ASCENSEUR,F.ENTREE_AIDE_HUMAINE,
    F.CHEMIN_PLAIN_PIED,F.CHEMIN_TERRAIN_STABLE,F.CHEMIN_RAMPE,F.SANITAIRES_PMR,
    F.STATIONNEMENT_PMR,F.STATIONNEMENT_EXT_PMR,F.ACCUEIL_PERSONNEL,F.ACCUEIL_PLAIN_PIED,F.ACCUEIL_SIGNALETIQUE];
  var searchIdx = new Array(DATA.length);
  var accessScore = new Int8Array(DATA.length);
  var accessIndex = new Uint8Array(DATA.length);
  var completenessKnown = new Uint8Array(DATA.length);
  var accessEssential = new Uint8Array(DATA.length);
  var accessLabelRank = new Uint8Array(DATA.length);
  var accessFamilies = new Uint8Array(DATA.length);
  var actCounts = new Array(ACTIVITES.length).fill(0);
  function listFrom(value){
    if(Array.isArray(value)) return value;
    if(value == null || value === '') return [];
    if(typeof value === 'string'){
      try{ var parsed=JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }catch(e){ return []; }
    }
    return [];
  }
  function labelRankFor(r){
    var labels = listFrom(r[F.LABELS]).map(function(v){ return String(v).toLowerCase(); });
    if(labels.indexOf('th') >= 0 || labels.indexOf('handiplage') >= 0) return 2;
    if(labels.indexOf('mobalib') >= 0 || labels.indexOf('dpt') >= 0) return 1;
    return 0;
  }
  function accessIndexFor(r){
    var points = 0;
    for(var d=0; d<ACCESS_DIMENSIONS.length; d++){
      var fields = ACCESS_DIMENSIONS[d].fields;
      for(var f=0; f<fields.length; f++){
        if(isTrue(r[fields[f]])){ points += ACCESS_DIMENSIONS[d].weight; break; }
      }
    }
    return points;
  }
  // La complétude compte une dimension dès qu'une valeur vraie OU fausse est
  // déclarée : elle mesure la présence d'informations, jamais l'accessibilité.
  function completenessFor(r){
    var known = 0;
    for(var d=0; d<ACCESS_DIMENSIONS.length; d++){
      var fields = ACCESS_DIMENSIONS[d].fields;
      for(var f=0; f<fields.length; f++){
        var value = r[fields[f]];
        if(isTrue(value) || isFalse(value)){ known++; break; }
      }
    }
    return known;
  }
  function completenessLabel(known){
    if(known >= 5) return 'Très complète';
    if(known >= 3) return 'Bien renseignée';
    if(known >= 1) return 'Partielle';
    return 'Non renseignée';
  }
  function buildSearchIndex(){
    searchIdx = new Array(DATA.length);
    accessScore = new Int8Array(DATA.length);
    accessIndex = new Uint8Array(DATA.length);
    completenessKnown = new Uint8Array(DATA.length);
    accessEssential = new Uint8Array(DATA.length);
    accessLabelRank = new Uint8Array(DATA.length);
    accessFamilies = new Uint8Array(DATA.length);
    actCounts = new Array(ACTIVITES.length).fill(0);
    for(var i=0;i<DATA.length;i++){
      var r = DATA[i];
      searchIdx[i] = normalize(r[F.NOM] + " " + r[F.ADR] + " " + COMMUNES[r[F.COM]] + " " + r[F.CP]);
      var sc = 0;
      for(var k=0;k<SCORE_FIELDS.length;k++){ if(isTrue(r[SCORE_FIELDS[k]])) sc++; }
      accessScore[i] = sc;
      accessIndex[i] = accessIndexFor(r);
      completenessKnown[i] = completenessFor(r);
      var essential = 0;
      for(var e=0; e<ACCESS_ESSENTIAL_FIELDS.length; e++){ if(isTrue(r[ACCESS_ESSENTIAL_FIELDS[e]])) essential++; }
      accessEssential[i] = essential;
      accessLabelRank[i] = labelRankFor(r);
      accessFamilies[i] = listFrom(r[F.FAMILLES]).length;
      actCounts[r[F.ACT]]++;
    }
  }
  buildSearchIndex();
  document.getElementById('statTotal').textContent = DATA.length.toLocaleString('fr-FR').replace(/\u202f/g,'\u00a0');
  document.getElementById('statCommunes').textContent = COMMUNES.length.toLocaleString('fr-FR').replace(/\u202f/g,'\u00a0');
  document.getElementById('statCats').textContent = ACTIVITES.length;

  // ---------- Ordre des activités (les plus représentées d'abord) ----------
  // L'activité ne se choisit plus au-dessus de la liste : elle est filtrée dans
  // le panneau « Filtres & tri », comme la ville et les autres critères.
  var order = ACTIVITES.map(function(n,idx){ return idx; }).sort(function(a,b){ return actCounts[b]-actCounts[a]; });
  // Les 66 entrées du catalogue sont des catégories détaillées ; ces familles
  // servent uniquement à les regrouper dans le sélecteur, sans masquer les
  // catégories ni modifier les identifiants stockés dans les fiches.
  var ACTIVITY_FAMILY_ORDER = ['Sport & mouvement','Culture & patrimoine','Plein air & nature','Loisirs & détente','Tourisme & découverte','Lieux de réception'];
  var ACTIVITY_FAMILY = {
    'sports et loisirs':'Sport & mouvement','salle de remise en forme':'Sport & mouvement','salle multisports':'Sport & mouvement','gymnase':'Sport & mouvement','stade':'Sport & mouvement','complexe sportif':'Sport & mouvement','salle de combat':'Sport & mouvement','club de sport':'Sport & mouvement','centre equestre':'Sport & mouvement','equipement sportif':'Sport & mouvement','tennis':'Sport & mouvement','circuit sportif deux roues voiture':'Sport & mouvement','cyclisme':'Sport & mouvement','patinoire':'Sport & mouvement','boulodrome':'Sport & mouvement','plateaux et terrains de jeux exterieurs':'Sport & mouvement','athletisme':'Sport & mouvement','arene':'Sport & mouvement','skatepark':'Sport & mouvement','ecole de ski et snowboard':'Sport & mouvement','piscine centre aquatique':'Sport & mouvement',
    'cinema':'Culture & patrimoine','centre culturel':'Culture & patrimoine','bibliotheque mediatheque':'Culture & patrimoine','conservatoire et ecole de musique':'Culture & patrimoine','theatre':'Culture & patrimoine','musee':'Culture & patrimoine','salle de spectacle':'Culture & patrimoine','art centre d art':'Culture & patrimoine','monument historique':'Culture & patrimoine','evenement culturel':'Culture & patrimoine','auditorium et salle de conference':'Culture & patrimoine','salle de concert':'Culture & patrimoine','galerie d art':'Culture & patrimoine','musique':'Culture & patrimoine','chateau':'Culture & patrimoine','opera':'Culture & patrimoine','observatoire astronomie':'Culture & patrimoine','salle de danse':'Culture & patrimoine','ecole de danse':'Culture & patrimoine',
    'accrobranche':'Plein air & nature','plage zone de baignade':'Plein air & nature','randonnees pedestres ou velos':'Plein air & nature','parc':'Plein air & nature','espace vert et naturel':'Plein air & nature','jardin botanique et ou zoologique':'Plein air & nature','refuge animalier':'Plein air & nature',
    'bowling':'Loisirs & détente','salle de jeux':'Loisirs & détente','loisirs creatifs':'Loisirs & détente','parc d attraction':'Loisirs & détente','casino':'Loisirs & détente','centre de loisirs':'Loisirs & détente','discotheque':'Loisirs & détente','jeux video':'Loisirs & détente','karaoke':'Loisirs & détente','escape game':'Loisirs & détente',
    'office de tourisme':'Tourisme & découverte','lieu de visite':'Tourisme & découverte','information touristique':'Tourisme & découverte','centre de vacances':'Tourisme & découverte','village de vacances':'Tourisme & découverte','oenotourisme':'Tourisme & découverte','aquarium':'Tourisme & découverte',
    'salle des fetes':'Lieux de réception','parc des expositions':'Lieux de réception'
  };
  function activityFamily(name){ return ACTIVITY_FAMILY[normalize(canonicalActivityName(name)).replace(/[^a-z0-9]+/g,' ').trim()] || 'Autres activités'; }

  // ---------- État des filtres ----------
  // Déclaré avant la construction du panneau « Filtres & tri » : les listes
  // d'activités et de villes lisent cet état pour se dessiner.
  var state = { query:'', activity:'', commune:'', access:[], sort:'access', minRating:0 };

  // ---------- Notes des avis (filtre « Avis ») ----------
  // Les avis vivent dans Supabase (hilia_reviews). Pour filtrer sur la moyenne
  // sans interroger chaque fiche, les notes sont chargées en une fois, en tâche
  // de fond, et seuls l'identifiant de fiche et la note sont demandés.
  var ratingStats = {};      // { idFiche: { count, sum } }
  var ratingsLoaded = false, ratingsFailed = false;
  function ratingOf(di){
    var ref = placeRef(di);
    return ref && ratingStats[ref] ? ratingStats[ref] : null;
  }
  function ratedPlacesCount(min){
    var n = 0;
    for(var ref in ratingStats){
      var s = ratingStats[ref];
      if(s && s.count && s.sum/s.count >= min) n++;
    }
    return n;
  }
  function ratingThresholdLabel(v){ return String(v).replace('.', ',')+'/5 et plus'; }
  async function loadReviewRatings(){
    if(!supabaseClient) return false;
    if(ratingsLoaded) return true;
    var pageSize = 1000, from = 0, next = {};
    try{
      for(;;){
        var res = await supabaseClient.from('hilia_reviews').select('place_id,rating').order('id',{ascending:true}).range(from, from+pageSize-1);
        if(res.error){ console.warn('Chargement des notes des avis impossible', res.error.message); ratingsFailed = true; ratingsLoaded = true; return false; }
        var rows = res.data || [];
        rows.forEach(function(row){
          var ref = row.place_id == null ? '' : String(row.place_id);
          var v = Number(row.rating);
          if(!ref || !isFinite(v) || v <= 0) return;
          var s = next[ref] || (next[ref] = {count:0, sum:0});
          s.count++; s.sum += v;
        });
        if(rows.length < pageSize) break;
        from += pageSize;
        if(from > 500000) break; // garde-fou
      }
    }catch(err){
      console.warn('Chargement des notes des avis impossible', err);
      ratingsFailed = true; ratingsLoaded = true; return false;
    }
    ratingStats = next;
    ratingsLoaded = true; ratingsFailed = false;
    return true;
  }
  // Un avis vient d'être publié ou retiré : la moyenne de cette fiche est recalculée
  // à partir des avis déjà chargés pour elle.
  function syncRatingFromLoaded(di){
    var ref = placeRef(di); if(!ref) return;
    var list = reviewsFor(di), sum = 0, n = 0;
    list.forEach(function(rv){ var v = Number(rv.rating); if(isFinite(v) && v > 0){ sum += v; n++; } });
    if(n) ratingStats[ref] = {count:n, sum:sum}; else delete ratingStats[ref];
    renderRatingOptions();
    if(state.minRating > 0) refresh();
  }

  // ---------- Filter groups (drawer) ----------
  var FILTER_GROUPS = [
    {title:"Stationnement & abords", items:[
      [F.TRANSPORT,"Transport en commun à proximité"],
      [F.STATIONNEMENT,"Stationnement disponible"],
      [F.STATIONNEMENT_PMR,"Places de stationnement PMR"],
      [F.STATIONNEMENT_EXT,"Stationnement extérieur disponible"],
      [F.STATIONNEMENT_EXT_PMR,"Places de stationnement extérieur PMR"]
    ]},
    {title:"Cheminement extérieur", items:[
      [F.CHEMIN_PLAIN_PIED,"Cheminement de plain-pied"],
      [F.CHEMIN_TERRAIN_STABLE,"Terrain stable"],
      [F.CHEMIN_REPERAGE,"Repérage des marches"],
      [F.CHEMIN_MAIN_COURANTE,"Main courante"],
      [F.CHEMIN_RAMPE,"Rampe d'accès"],
      [F.CHEMIN_BANDE_GUIDAGE,"Bande de guidage (malvoyants)"]
    ]},
    {title:"Entrée", items:[
      [F.ENTREE_REPERABLE,"Entrée facilement repérable"],
      [F.ENTREE_PLAIN_PIED,"Entrée de plain-pied"],
      [F.ENTREE_ASCENSEUR,"Ascenseur"],
      [F.ENTREE_RAMPE,"Rampe d'accès"],
      [F.ENTREE_DISPOSITIF_APPEL,"Dispositif d'appel"],
      [F.ENTREE_BALISE_SONORE,"Balise sonore"],
      [F.ENTREE_AIDE_HUMAINE,"Aide humaine possible"],
      [F.ENTREE_SPECIFIQUE_PMR,"Entrée spécifique PMR"]
    ]},
    {title:"Accueil", items:[
      [F.ACCUEIL_PERSONNEL,"Personnel présent à l'accueil"],
      [F.ACCUEIL_AUDIODESCR,"Audiodescription disponible"],
      [F.ACCUEIL_EQUIP_MALENT,"Équipements malentendants"],
      [F.ACCUEIL_PLAIN_PIED,"Cheminement de plain-pied à l'accueil"],
      [F.ACCUEIL_SIGNALETIQUE,"Signalétique intérieure adaptée"]
    ]},
    {title:"Sanitaires", items:[
      [F.SANITAIRES_DISPO,"Sanitaires disponibles au public"],
      [F.SANITAIRES_PMR,"Sanitaires adaptés PMR"]
    ]}
  ];
  var FILTER_GROUPS_EXTRA = [
    {title:"Pratique de l’activité (lieux qualifiés par le prestataire)", items:[
      [F.Q_FAUTEUIL,"Activité réalisable en fauteuil"],
      [F.Q_FAUT_AUTONOME,"Réalisable en fauteuil, de manière autonome"],
      [F.Q_EFFORT_FAIBLE,"Courte durée, effort très faible"],
      [F.Q_SIEGES,"Sièges disponibles tout au long"]
    ]},
    {title:"Confort sensoriel & compréhension", items:[
      [F.Q_ESPACE_CALME,"Espace calme ou zone de repli"],
      [F.Q_PAS_FLASH,"Pas d’effets lumineux brutaux"],
      [F.Q_PAUSE,"Pause possible pendant l’activité"],
      [F.Q_CRENEAUX,"Créneaux à faible affluence conseillés"],
      [F.Q_FALC,"Supports en FALC"]
    ]},
    {title:"Communication", items:[
      [F.Q_RESA_SANS_APPEL,"Réservation sans appel téléphonique"],
      [F.Q_BIM,"Boucle à induction magnétique"],
      [F.Q_AUDIODESC,"Audiodescription / visite adaptée"]
    ]},
    // Le « tarif réduit » a son propre filtre en tête du panneau : il n'est pas
    // répété ici.
    {title:"Accompagnement", items:[
      [F.Q_GRATUIT_ACCOMP,"Accompagnateur gratuit"]
    ]}
  ];
  var filterGroupsEl = document.getElementById('filterGroups');
  FILTER_GROUPS.concat(FILTER_GROUPS_EXTRA).forEach(function(group){
    var g = document.createElement('details'); g.className='fgroup fgroup-collapsible';
    g.open = group.title==='Entrée';
    var h = document.createElement('summary'); h.className='fgroup-title'; h.textContent = group.title; g.appendChild(h);
    var cl = document.createElement('div'); cl.className='check-list';
    group.items.forEach(function(item){
      var label = document.createElement('label');
      var cb = document.createElement('input'); cb.type='checkbox'; cb.dataset.field=item[0];
      label.appendChild(cb); label.appendChild(document.createTextNode(item[1]));
      cl.appendChild(label);
    });
    g.appendChild(cl); filterGroupsEl.appendChild(g);
  });
  function syncGroupSummaries(){
    filterGroupsEl.querySelectorAll('details.fgroup-collapsible').forEach(function(group){
      var title=group.querySelector('.fgroup-title');
      if(!title) return;
      var n=group.querySelectorAll('input[type=checkbox]:checked').length;
      if(!title.dataset.base) title.dataset.base=title.textContent;
      title.textContent=title.dataset.base+(n?' · '+n+' sélectionné'+(n>1?'s':''):'');
    });
  }
  // ---------- Activité, ville et tarif réduit (en tête du panneau) ----------
  // Deux de ces listes sont longues (65 activités, plus de 13 000 communes) :
  // chacune a sa propre barre de recherche, et la liste des villes s'arrête aux
  // villes les plus fournies tant que la recherche ne précise pas.
  var CITY_LIMIT = 40;
  var communeCounts = new Int32Array(COMMUNES.length);
  var communeOrder = [];
  for(var cc=0; cc<DATA.length; cc++){
    var comIdx = DATA[cc][F.COM];
    if(typeof comIdx === 'number' && comIdx >= 0 && comIdx < communeCounts.length) communeCounts[comIdx]++;
  }
  for(var ck=0; ck<COMMUNES.length; ck++){ if(communeCounts[ck] > 0) communeOrder.push(ck); }
  communeOrder.sort(function(a,b){ return communeCounts[b]-communeCounts[a] || COMMUNES[a].localeCompare(COMMUNES[b],'fr'); });

  function countLabel(n){ return n.toLocaleString('fr-FR'); }
  function optionHtml(name, value, label, count, checked){
    return '<label class="filter-option"><input type="radio" name="'+name+'" value="'+value+'"'+(checked?' checked':'')+'>'+
      '<span class="fo-name">'+escapeHtml(label)+'</span>'+
      (count==null?'':'<span class="fo-count">'+countLabel(count)+'</span>')+'</label>';
  }
  function buildSearchGroup(legend, name, placeholder, listLabel){
    var group = document.createElement('fieldset'); group.className='fgroup';
    var lg = document.createElement('legend'); lg.textContent=legend; group.appendChild(lg);
    var search = document.createElement('input');
    search.type='search'; search.className='filter-search'; search.autocomplete='off';
    search.placeholder=placeholder; search.setAttribute('aria-label', placeholder);
    group.appendChild(search);
    var list = document.createElement('div');
    list.className='filter-list'; list.id=name+'Options';
    list.setAttribute('role','radiogroup'); list.setAttribute('aria-label', listLabel);
    search.setAttribute('aria-controls', list.id);
    group.appendChild(list);
    var hint = document.createElement('p'); hint.className='filter-hint'; hint.hidden=true;
    group.appendChild(hint);
    return {group:group, search:search, list:list, hint:hint, name:name};
  }

  var actFilter = buildSearchGroup('Catégorie d’activité', 'actFilter', 'Rechercher une catégorie…', 'Filtrer par catégorie d’activité');
  var cityFilter = buildSearchGroup('Ville', 'cityFilter', 'Rechercher une ville…', 'Filtrer par ville');

  function renderActivityOptions(){
    var q = normalize(actFilter.search.value);
    var groups = {}, shown = 0;
    order.forEach(function(idx){
      if(q && normalize(ACTIVITES[idx]).indexOf(q) === -1) return;
      var family=activityFamily(ACTIVITES[idx]);
      (groups[family]=groups[family]||[]).push(idx);
      shown++;
    });
    var html = optionHtml('actFilter','','Toutes les activités',null,state.activity==='');
    var families=ACTIVITY_FAMILY_ORDER.concat(Object.keys(groups).filter(function(f){ return ACTIVITY_FAMILY_ORDER.indexOf(f)===-1; }));
    families.forEach(function(family){
      var list=groups[family];
      if(!list || !list.length) return;
      html += '<div class="filter-family" role="group" aria-label="'+escapeAttr(family)+'"><p class="filter-family-title">'+escapeHtml(family)+'</p>';
      list.forEach(function(idx){
        html += optionHtml('actFilter', idx, ACTIVITES[idx], actCounts[idx], String(state.activity)===String(idx));
      });
      html += '</div>';
    });
    actFilter.list.innerHTML = html;
    actFilter.hint.hidden = shown > 0;
    actFilter.hint.textContent = shown ? '' : 'Aucune activité ne correspond à cette recherche.';
  }
  function renderCityOptions(){
    var q = normalize(cityFilter.search.value);
    var html = optionHtml('cityFilter','','Toutes les villes',null,state.commune==='');
    var shown = 0, total = 0;
    for(var i=0; i<communeOrder.length; i++){
      var idx = communeOrder[i];
      if(q && normalize(COMMUNES[idx]).indexOf(q) === -1) continue;
      total++;
      if(shown >= CITY_LIMIT) continue;
      html += optionHtml('cityFilter', idx, COMMUNES[idx], communeCounts[idx], String(state.commune)===String(idx));
      shown++;
    }
    cityFilter.list.innerHTML = html;
    var rest = total - shown;
    cityFilter.hint.hidden = rest <= 0;
    cityFilter.hint.textContent = rest > 0 ? 'Encore '+countLabel(rest)+' ville'+(rest>1?'s':'')+' : précisez la recherche.' : '';
  }

  // Tarif réduit : un seul critère, à cocher ou à décocher.
  var tarifGroup = document.createElement('fieldset'); tarifGroup.className='fgroup';
  var tarifLegend = document.createElement('legend'); tarifLegend.textContent='Tarif'; tarifGroup.appendChild(tarifLegend);
  var tarifList = document.createElement('div'); tarifList.className='check-list';
  var tarifLabel = document.createElement('label');
  var tarifCb = document.createElement('input'); tarifCb.type='checkbox'; tarifCb.dataset.field=F.Q_TARIF_AVANT;
  tarifLabel.appendChild(tarifCb);
  tarifLabel.appendChild(document.createTextNode('Tarif réduit ou gratuité pour l’usager'));
  tarifList.appendChild(tarifLabel);
  tarifGroup.appendChild(tarifList);
  var tarifCount = 0;
  var tarifHint = document.createElement('p'); tarifHint.className='filter-hint';
  function renderTarifHint(){
    tarifCount = 0;
    for(var tq=0; tq<DATA.length; tq++){ if(isTrue(DATA[tq][F.Q_TARIF_AVANT])) tarifCount++; }
    tarifHint.textContent = tarifCount
      ? countLabel(tarifCount)+' fiche'+(tarifCount>1?'s':'')+' renseigne'+(tarifCount>1?'nt':'')+' ce critère.'
      : 'Aucune fiche ne renseigne encore ce critère.';
  }
  renderTarifHint();
  tarifGroup.appendChild(tarifHint);

  // Avis : barre de sélection de 1 à 5 étoiles. La note choisie est la note
  // minimale ; « Toutes » ne restreint rien.
  var ratingGroup = document.createElement('fieldset'); ratingGroup.className='fgroup';
  var ratingLegend = document.createElement('legend'); ratingLegend.textContent='Avis'; ratingGroup.appendChild(ratingLegend);
  var ratingList = document.createElement('div');
  ratingGroup.appendChild(ratingList);
  var ratingHint = document.createElement('p'); ratingHint.className='filter-hint'; ratingGroup.appendChild(ratingHint);

  function renderRatingOptions(){
    var html = '<div class="rating-bar" role="radiogroup" aria-label="Note minimale des avis, de 1 à 5 étoiles">'+
      '<label><input type="radio" name="ratingFilter" value=""'+(state.minRating?'':' checked')+'><span>Toutes</span></label>';
    for(var step=1; step<=5; step++){
      html += '<label><input type="radio" name="ratingFilter" value="'+step+'" aria-label="'+step+' sur 5 et plus"'+(state.minRating===step?' checked':'')+'>'+
        '<span>'+step+'<span class="rating-star" aria-hidden="true">★</span></span></label>';
    }
    html += '</div>';
    ratingList.innerHTML = html;
    var withReviews = ratedPlacesCount(0);
    if(!withReviews){
      ratingHint.textContent = ratingsFailed
        ? 'Les notes n’ont pas pu être chargées. Rechargez la page pour réessayer.'
        : ((ratingsLoaded || DEFER_PLACES) ? 'Aucun avis publié pour l’instant : ce filtre s’activera dès le premier avis.' : 'Chargement des notes…');
      return;
    }
    if(state.minRating > 0){
      var matched = ratedPlacesCount(state.minRating);
      ratingHint.textContent = countLabel(matched)+' fiche'+(matched>1?'s':'')+' sur '+countLabel(withReviews)+' '+(matched>1?'atteignent':'atteint')+' '+ratingThresholdLabel(state.minRating)+'.';
    }else{
      ratingHint.textContent = countLabel(withReviews)+' fiche'+(withReviews>1?'s':'')+' '+(withReviews>1?'ont':'a')+' au moins un avis. Choisissez une note pour ne garder que les mieux notées.';
    }
  }

  // Ordre final : activité, ville, tarif, avis, puis les critères d'accessibilité.
  var firstAccessGroup = filterGroupsEl.firstChild;
  filterGroupsEl.insertBefore(tarifGroup, firstAccessGroup);
  filterGroupsEl.insertBefore(ratingGroup, firstAccessGroup);
  filterGroupsEl.insertBefore(cityFilter.group, tarifGroup);
  filterGroupsEl.insertBefore(actFilter.group, cityFilter.group);

  actFilter.search.addEventListener('input', renderActivityOptions);
  cityFilter.search.addEventListener('input', renderCityOptions);
  renderActivityOptions();
  renderCityOptions();
  renderRatingOptions();

  // ---------- Formulaire d'accessibilité (création / modification de lieux) ----------
  var ACCESS_NUM_FIELDS = [[F.CHEMIN_MARCHES,'Nombre de marches sur le cheminement'],[F.ENTREE_MARCHES,'Nombre de marches à l’entrée'],[F.ENTREE_LARGEUR,'Largeur minimale de l’entrée (cm)']];
  function accessFormHtml(prefix,row){
    var h='<details class="access-fieldset full"><summary>Informations d’accessibilité (facultatif)</summary><p class="auth-note" style="margin:8px 0 0">Laissez « Non renseigné » si vous ne savez pas.</p>';
    FILTER_GROUPS.forEach(function(g){
      h+='<div class="access-group"><strong>'+escapeHtml(g.title)+'</strong>';
      g.items.forEach(function(it){
        var v=row?(isTrue(row[it[0]])?'1':isFalse(row[it[0]])?'0':''):'', id=prefix+'Acc'+it[0];
        h+='<div class="access-row"><label for="'+id+'">'+escapeHtml(it[1])+'</label><select id="'+id+'" name="acc_'+it[0]+'"><option value=""'+(v===''?' selected':'')+'>Non renseigné</option><option value="1"'+(v==='1'?' selected':'')+'>Oui</option><option value="0"'+(v==='0'?' selected':'')+'>Non</option></select></div>';
      });
      h+='</div>';
    });
    h+='<div class="access-group"><strong>Marches et largeur</strong>';
    ACCESS_NUM_FIELDS.forEach(function(n){
      var cur=row&&row[n[0]]!=null&&isFinite(Number(row[n[0]]))?Number(row[n[0]]):'', id=prefix+'Acc'+n[0];
      h+='<div class="access-row"><label for="'+id+'">'+escapeHtml(n[1])+'</label><input id="'+id+'" name="acc_'+n[0]+'" type="number" min="0" max="1000" inputmode="numeric" value="'+cur+'"></div>';
    });
    return h+'</div></details>';
  }
  function readAccess(fd){
    var out={};
    FILTER_GROUPS.forEach(function(g){ g.items.forEach(function(it){ var v=fd.get('acc_'+it[0]); out[it[0]]=(v==='1'||v==='0')?Number(v):null; }); });
    ACCESS_NUM_FIELDS.forEach(function(n){ var v=(fd.get('acc_'+n[0])||'').toString().trim(); out[n[0]]=(v!==''&&isFinite(Number(v))&&Number(v)>=0)?Number(v):null; });
    return out;
  }
  function accSummary(p){ if(!p||!p.access) return ''; var n=Object.keys(p.access).filter(function(k){return p.access[k]!=null;}).length; return n?'<br><small>'+n+' information(s) d’accessibilité renseignée(s)</small>':''; }

  // ---------- Icons ----------
  function icon(name){
    var paths = {
      wheelchair:'<circle cx="12" cy="5" r="1.6"/><path d="M12 7v4.4M12 11.4l-3.6 6.2M12 11.4l3.6 6.2M8.6 14h6.8M12 11.4c0 3 2.4 5.4 5.4 5.4"/>',
      wc:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 8v8M9 12h6M15 8v3a1.5 1.5 0 0 0 3 0V8"/>',
      parking:'<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 16V8h3.2a2.4 2.4 0 0 1 0 4.8H9"/>',
      ramp:'<path d="M4 18h16M4 18L15 6M15 6h4v4"/>',
      link:'<path d="M9 15l6-6M10 6h6a2 2 0 0 1 2 2v6M14 18H8a2 2 0 0 1-2-2V10"/>',
      chevron:'<path d="M9 6l6 6-6 6"/>'
    };
    return '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||'')+'</svg>';
  }

  // ---------- State ----------
  var filtered = [];

  function computeFiltered(){
    var q = normalize(state.query);
    var act = state.activity;
    var com = state.commune;
    var acc = state.access;
    var out = [];
    for(var idx=0; idx<DATA.length; idx++){
      var r = DATA[idx];
      if(act !== '' && String(r[F.ACT]) !== act) continue;
      if(com !== '' && String(r[F.COM]) !== com) continue;
      if(state.minRating > 0){
        var rs = ratingOf(idx);
        if(!rs || !rs.count || rs.sum/rs.count < state.minRating) continue;
      }
      if(q && searchIdx[idx].indexOf(q) === -1) continue;
      var ok = true;
      for(var a=0;a<acc.length;a++){ if(!isTrue(r[acc[a]])){ ok=false; break; } }
      if(!ok) continue;
      out.push(idx);
    }
    if(state.sort === 'name'){ out.sort(function(a,b){ return DATA[a][F.NOM].localeCompare(DATA[b][F.NOM],'fr'); }); }
    else if(state.sort === 'commune'){ out.sort(function(a,b){ return COMMUNES[DATA[a][F.COM]].localeCompare(COMMUNES[DATA[b][F.COM]],'fr'); }); }
    else if(state.sort === 'access'){
      // Complétude d'abord (informations présentes), puis couverture positive,
      // critères essentiels, label officiel, familles, puis nom.
      out.sort(function(a,b){
        return (completenessKnown[b]-completenessKnown[a]) ||
          (accessIndex[b]-accessIndex[a]) ||
          (accessScore[b]-accessScore[a]) ||
          (accessEssential[b]-accessEssential[a]) ||
          (accessLabelRank[b]-accessLabelRank[a]) ||
          (accessFamilies[b]-accessFamilies[a]) ||
          DATA[a][F.NOM].localeCompare(DATA[b][F.NOM],'fr');
      });
    }
    else if(state.sort === 'rating'){
      // Meilleure moyenne d'abord ; les fiches sans avis passent en dernier.
      var avgCache={};
      var avgOf=function(di){ var s=ratingOf(di); return s && s.count ? s.sum/s.count : -1; };
      out.sort(function(a,b){
        if(!(a in avgCache)) avgCache[a]=avgOf(a);
        if(!(b in avgCache)) avgCache[b]=avgOf(b);
        return avgCache[b]-avgCache[a] || DATA[a][F.NOM].localeCompare(DATA[b][F.NOM],'fr');
      });
    }
    filtered = out;
    document.getElementById('resultCount').textContent = filtered.length.toLocaleString('fr-FR');
    var resultCountLabel = document.getElementById('resultCountLabel');
    if(resultCountLabel) resultCountLabel.textContent = filtered.length > 1 ? 'lieux trouvés' : 'lieu trouvé';
  }

  // ---------- List: paginated results (real <ul>, predictable focus, no virtual scroll) ----------
  var viewport = document.getElementById('viewport');
  var PAGE_SIZE = 24, pageIdx = 0, initialized = false;

  function amenityLi(v, name, label){
    // Ne pas afficher un critère dont la valeur est inconnue.
    // Les critères connus restent explicitement annoncés aux lecteurs d’écran.
    if (!isTrue(v) && !isFalse(v)) return '';
    var st = isTrue(v) ? 'on' : 'off';
    var txt = st === 'on' ? 'oui' : 'non';
    return '<li class="badge '+st+'"><span aria-hidden="true" title="'+label+' : '+txt+'">'+icon(name)+'</span><span class="sr-only">'+label+' : '+txt+'</span></li>';
  }
  function cardHtml(di){
    var r = DATA[di];
    var color = colorFor(r[F.ACT]);
    var idx = accessIndex[di];
    var known = completenessKnown[di];
    var accessBadge = r._accessUnknown
      ? '<span class="tc-score tc-score-unknown" title="Informations d’accessibilité non renseignées"><span class="tc-score-label">Complétude</span> <span class="tc-score-value">Non renseignée</span></span>'
      : '<span class="tc-score" title="Complétude des informations : '+completenessLabel(known)+' ('+known+' dimensions sur 6). Cet indicateur ne mesure pas l’accessibilité réelle."><span class="tc-score-label">Complétude</span> <span class="tc-score-value">'+completenessLabel(known)+'</span></span>';
    var badgesHtml =
      amenityLi(r[F.ENTREE_PLAIN_PIED],'wheelchair','Entrée de plain-pied')+
      amenityLi(r[F.SANITAIRES_PMR],'wc','Sanitaires adaptés PMR')+
      amenityLi(r[F.STATIONNEMENT_PMR],'parking','Stationnement PMR')+
      amenityLi(r[F.ENTREE_RAMPE],'ramp','Rampe d’accès');
    return (
      '<article class="ticket-card" data-idx="'+di+'" data-access-index="'+idx+'" style="--place-color:'+color+'">'+
        '<div class="tc-body">'+
          '<div class="tc-head">'+
            '<p class="tc-kicker"><span class="tc-dot" aria-hidden="true"></span>'+escapeHtml(ACTIVITES[r[F.ACT]])+'</p>'+
            accessBadge+
          '</div>'+
          '<h3 class="tc-name"><button type="button" class="tc-open">'+escapeHtml(r[F.NOM])+'</button></h3>'+
          '<p class="tc-loc">'+escapeHtml(COMMUNES[r[F.COM]])+' · '+escapeHtml(r[F.CP])+'</p>'+
          '<div class="tc-foot"><ul class="tc-amenities" aria-label="Critères d’accessibilité principaux">'+badgesHtml+'</ul><div class="review-mini" data-review-mini-index="'+di+'">'+reviewSummaryHtml(di,'mini')+'</div><span class="tc-chev" aria-hidden="true">'+icon('chevron')+'</span></div>'+
        '</div>'+
      '</article>'
    );
  }
  function pagesCount(){ return Math.max(1, Math.ceil(filtered.length/PAGE_SIZE)); }
  function pagerHtml(pages){
    var first = pageIdx===0, last = pageIdx>=pages-1;
    var from = pageIdx*PAGE_SIZE+1, to = Math.min(filtered.length,(pageIdx+1)*PAGE_SIZE);
    var f = function(n){ return n.toLocaleString('fr-FR'); };
    return '<nav class="pager" aria-label="Pagination des résultats">'+
      '<p class="pager-status">Résultats '+f(from)+' à '+f(to)+' sur '+f(filtered.length)+' · Page '+f(pageIdx+1)+' sur '+f(pages)+'</p>'+
      '<div class="pager-buttons">'+
        '<button type="button" data-page-go="first"'+(first?' disabled':'')+'><span aria-hidden="true">« </span>Première<span class="sr-only"> page</span></button>'+
        '<button type="button" data-page-go="prev"'+(first?' disabled':'')+'><span aria-hidden="true">‹ </span>Précédente<span class="sr-only"> page</span></button>'+
        '<button type="button" data-page-go="next"'+(last?' disabled':'')+'>Suivante<span class="sr-only"> page</span><span aria-hidden="true"> ›</span></button>'+
        '<button type="button" data-page-go="last"'+(last?' disabled':'')+'>Dernière<span class="sr-only"> page</span><span aria-hidden="true"> »</span></button>'+
      '</div>'+
      '<form class="pager-jump" data-pager-form><label for="pagerJump">Aller à la page</label><input id="pagerJump" type="number" inputmode="numeric" min="1" max="'+pages+'" value="'+(pageIdx+1)+'"><button type="submit">Aller</button></form>'+
    '</nav>';
  }
  function renderList(){
    var pages = pagesCount();
    if(pageIdx>=pages) pageIdx=pages-1;
    if(pageIdx<0) pageIdx=0;
    if(!filtered.length){
      viewport.innerHTML='<div class="empty-state" id="emptyMsg"><h3>Aucun lieu ne correspond à ces critères</h3><p>Essayez d’élargir la recherche ou de retirer un filtre.</p></div>';
      return;
    }
    var start = pageIdx*PAGE_SIZE, slice = filtered.slice(start, start+PAGE_SIZE);
    var html = '<ul class="results-list" aria-label="Lieux, page '+(pageIdx+1)+' sur '+pages+'">';
    slice.forEach(function(di){ html += '<li>'+cardHtml(di)+'</li>'; });
    html += '</ul>'+pagerHtml(pages);
    viewport.innerHTML = html;
    // Avis des fiches de la page courante (une seule requête par page).
    ensureReviews(slice, function(){ refreshReviewMinis(); });
  }
  function goToPage(n){
    var pages = pagesCount();
    n = Math.max(0, Math.min(pages-1, n));
    if(n===pageIdx) return;
    pageIdx = n; renderList();
    var h = document.getElementById('resultsHeading');
    if(h){ h.scrollIntoView({block:'start'}); h.focus({preventScroll:true}); }
    announce('Page '+(pageIdx+1)+' sur '+pages+'.', 100);
  }
  viewport.addEventListener('click', function(e){
    var go = e.target.closest('[data-page-go]');
    if(go){
      var k = go.dataset.pageGo, pages = pagesCount();
      goToPage(k==='first' ? 0 : k==='prev' ? pageIdx-1 : k==='next' ? pageIdx+1 : pages-1);
      return;
    }
    var card = e.target.closest('.ticket-card'); if(!card) return;
    openDetail(parseInt(card.dataset.idx,10));
  });
  viewport.addEventListener('submit', function(e){
    var form = e.target.closest('[data-pager-form]'); if(!form) return;
    e.preventDefault();
    var v = parseInt(form.querySelector('input').value,10);
    if(!isNaN(v)) goToPage(v-1);
  });
  function announceResults(){
    // Tant que les fiches ne sont pas chargées, il n'y a rien à annoncer.
    if(!DATA.length) return;
    var n = filtered.length, pages = pagesCount();
    announce(n===0 ? 'Aucun lieu trouvé.' :
      n.toLocaleString('fr-FR')+' lieu'+(n>1?'x':'')+' trouvé'+(n>1?'s':'')+(currentTab==='list' ? ', page 1 sur '+pages.toLocaleString('fr-FR') : ', affichés sur la carte')+'.', 700);
  }
  function refresh(){
    computeFiltered(); pageIdx = 0;
    if(currentTab==='list') renderList(); else drawMap();
    updateFilterDot();
    if(initialized) announceResults();
  }

  // ---------- Controls ----------
  var searchInput = document.getElementById('searchInput');
  var debTimer=null;
  searchInput.addEventListener('input', function(){ clearTimeout(debTimer); debTimer=setTimeout(function(){ state.query=searchInput.value; refresh(); }, 140); });
  // Recherche depuis une autre page : les résultats vivent dans l'exploration.
  // La première saisie bascule sur cette section sans rechargement ; sur une page
  // de contenu, le jeu de données est chargé à ce moment-là (ensurePlaces).
  var searchSwitching=false;
  function searchFromOtherPage(){
    if(currentPage==='explore' || searchSwitching) return;
    searchSwitching=true;
    ensurePlaces().then(function(ok){
      searchSwitching=false;
      if(!ok) return;
      state.query=searchInput.value;
      navigatePage('explore', true);
      refresh();
      searchInput.focus({preventScroll:true});
      try{ searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); }catch(e){}
    });
  }
  searchInput.addEventListener('input', searchFromOtherPage);
  document.getElementById('sortSelect').addEventListener('change', function(e){ state.sort = e.target.value; });
  filterGroupsEl.addEventListener('change', function(e){
    var t = e.target;
    // Une seule activité, une seule ville : la liste se comporte comme un choix unique.
    if(t && t.type === 'radio'){
      if(t.name === 'actFilter') state.activity = t.value;
      if(t.name === 'cityFilter') state.commune = t.value;
      if(t.name === 'ratingFilter') state.minRating = t.value ? Number(t.value) : 0;
    }
    var boxes = filterGroupsEl.querySelectorAll('input[type=checkbox]:checked');
    state.access = Array.from(boxes).map(function(cb){ return parseInt(cb.dataset.field,10); });
    syncGroupSummaries();
    updateFilterDot();
  });
  function activeFilterLabels(){
    var parts = [];
    if(state.activity !== '') parts.push(ACTIVITES[Number(state.activity)] || '');
    if(state.commune !== '') parts.push('Ville : '+(COMMUNES[Number(state.commune)] || ''));
    if(state.minRating > 0) parts.push('Avis '+ratingThresholdLabel(state.minRating));
    var tarif = state.access.indexOf(F.Q_TARIF_AVANT) !== -1;
    if(tarif) parts.push('Tarif réduit');
    var n = state.access.filter(function(f){ return f !== F.Q_TARIF_AVANT; }).length;
    if(n) parts.push(n+' critère'+(n>1?'s':'')+' d’accessibilité');
    if(state.sort !== 'access') parts.push('Tri : '+(state.sort === 'name' ? 'nom' : state.sort === 'commune' ? 'commune' : 'note des avis'));
    return parts.filter(Boolean);
  }
  function updateFilterDot(){
    var parts = activeFilterLabels();
    var has = parts.length > 0;
    document.getElementById('filterBtn').classList.toggle('has-filters', has);
    var sr = document.getElementById('filterCountSr');
    if(sr) sr.textContent = has ? ' - '+parts.length+' filtre'+(parts.length>1?'s':'')+' actif'+(parts.length>1?'s':'') : '';
    var summary = document.getElementById('filterSummary');
    if(summary) summary.textContent = parts.join(' · ');
  }
  document.getElementById('resetBtn').addEventListener('click', function(){
    state.access=[]; state.sort='access'; state.activity=''; state.commune=''; state.minRating=0;
    document.getElementById('sortSelect').value='access';
    filterGroupsEl.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.checked=false; });
    actFilter.search.value=''; cityFilter.search.value='';
    renderActivityOptions(); renderCityOptions(); renderRatingOptions(); syncGroupSummaries();
    refresh(); closeDrawer(); announce('Filtres réinitialisés.',900);
  });
  document.getElementById('applyBtn').addEventListener('click', function(){ refresh(); closeDrawer(); });

  var drawer = document.getElementById('drawer'), drawerScrim = document.getElementById('drawerScrim');
  var modalFocusReturn=null, activeModal=null;
  function getFocusable(container){
    return Array.prototype.slice.call(container.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(function(el){return el.offsetParent!==null || el===document.activeElement;});
  }
  var settingsPanel=document.getElementById('accessibilitySettings'), settingsScrim=document.getElementById('settingsScrim'), settingsBtn=document.getElementById('accessibilitySettingsBtn');
  function syncModalLock(){
    var detailOpen=overlayBg.classList.contains('open'), drawerOpen=drawer.classList.contains('open'), settingsOpen=!!settingsPanel && !settingsPanel.hidden && settingsPanel.getAttribute('aria-hidden')==='false', open=detailOpen||drawerOpen||settingsOpen;
    document.body.classList.toggle('modal-open',open);
    ['.topnav','#siteMain','.footer'].forEach(function(sel){ var el=document.querySelector(sel); if(el && 'inert' in el) el.inert=open; });
    drawer.setAttribute('aria-hidden',drawerOpen?'false':'true'); detailPanel.setAttribute('aria-hidden',detailOpen?'false':'true');
    if(settingsPanel) settingsPanel.setAttribute('aria-hidden',settingsOpen?'false':'true');
    if(settingsBtn) settingsBtn.setAttribute('aria-expanded',settingsOpen?'true':'false');
    if(!open){activeModal=null;if(modalFocusReturn&&document.contains(modalFocusReturn))modalFocusReturn.focus();modalFocusReturn=null;}
  }
  function activateModal(panel){
    activeModal=panel;if(!modalFocusReturn)modalFocusReturn=document.activeElement;syncModalLock();
    setTimeout(function(){var f=getFocusable(panel);if(f.length)f[0].focus();else{panel.setAttribute('tabindex','-1');panel.focus();}},0);
  }
  function closeSettings(){ if(!settingsPanel || settingsPanel.hidden)return; settingsPanel.hidden=true; settingsScrim.hidden=true; syncModalLock(); }
  function openSettings(){ closeDrawer(); closeDetail(); modalFocusReturn=document.activeElement; settingsPanel.hidden=false; settingsScrim.hidden=false; settingsPanel.setAttribute('aria-hidden','false'); activateModal(settingsPanel); }
  if(settingsBtn) settingsBtn.addEventListener('click',openSettings);
  document.getElementById('settingsClose').addEventListener('click',closeSettings);
  settingsScrim.addEventListener('click',closeSettings);
  document.addEventListener('keydown',function(e){
    if(!activeModal||!document.body.classList.contains('modal-open'))return;
    if(e.key==='Tab'){var f=getFocusable(activeModal);if(!f.length)return;var first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  });
  function openDrawer(){closeDetail();modalFocusReturn=document.activeElement;drawer.classList.add('open');drawerScrim.classList.add('open');activateModal(drawer);}
  function closeDrawer(){drawer.classList.remove('open');drawerScrim.classList.remove('open');if(!overlayBg.classList.contains('open'))syncModalLock();}
  document.getElementById('filterBtn').addEventListener('click', openDrawer);
  document.getElementById('profileNavBtn').addEventListener('click', function(e){e.preventDefault();navigatePage('profile',true);});
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  drawerScrim.addEventListener('click', closeDrawer);

  // ---------- Tabs ----------
  var currentTab = 'list';
  var tabListBtn = document.getElementById('tabListBtn'), tabMapBtn = document.getElementById('tabMapBtn');
  var gridWrap = document.getElementById('gridWrap'), mapWrap = document.getElementById('mapWrap');
  gridWrap.hidden=false; mapWrap.hidden=true;
  function setMapTab(){
    currentTab='map'; tabMapBtn.classList.add('active'); tabListBtn.classList.remove('active');
    tabMapBtn.setAttribute('aria-selected','true'); tabListBtn.setAttribute('aria-selected','false'); updateTabIndex(); announce('Affichage : carte.',100);
    gridWrap.classList.add('hidden'); mapWrap.classList.add('active'); gridWrap.hidden=true; mapWrap.hidden=false;
    syncChromeOffset();
    if(!leafletMap) initLeafletMap();
    [0,60,180,420].forEach(function(ms){ setTimeout(function(){ if(leafletMap && currentTab==='map') leafletMap.invalidateSize({pan:false,animate:false}); },ms); });
    drawMap();
  }
  function setListTab(){
    currentTab='list'; tabListBtn.classList.add('active'); tabMapBtn.classList.remove('active');
    tabListBtn.setAttribute('aria-selected','true'); tabMapBtn.setAttribute('aria-selected','false'); updateTabIndex(); announce('Affichage : liste.',100);
    gridWrap.classList.remove('hidden'); mapWrap.classList.remove('active'); gridWrap.hidden=false; mapWrap.hidden=true;
    renderList();
  }
  tabListBtn.addEventListener('click', function(){ if(currentTab!=='list') setListTab(); });
  tabMapBtn.addEventListener('click', function(){ if(currentTab!=='map') setMapTab(); });
  var tabButtons=[tabListBtn,tabMapBtn];
  function updateTabIndex(){ tabButtons.forEach(function(b){ b.tabIndex = b.getAttribute('aria-selected')==='true' ? 0 : -1; }); }
  document.querySelector('#mainTabbar [role="tablist"]').addEventListener('keydown', function(e){
    var i=tabButtons.indexOf(document.activeElement); if(i<0) return; var n;
    if(e.key==='ArrowRight'||e.key==='ArrowLeft') n=(i+1)%tabButtons.length;
    else if(e.key==='Home') n=0; else if(e.key==='End') n=tabButtons.length-1; else return;
    e.preventDefault(); tabButtons[n].focus(); tabButtons[n].click();
  });
  document.getElementById('mapToListBtn').addEventListener('click', function(){ setListTab(); tabListBtn.focus(); });
  // Accueil : « Explorer les lieux » amène aux résultats sans rechargement.
  var heroExploreBtn = document.getElementById('heroExploreBtn');
  if(heroExploreBtn) heroExploreBtn.addEventListener('click', function(){
    var target = document.getElementById('resultsHeading');
    if(!target) return;
    target.scrollIntoView({block:'start'});
    target.focus({preventScroll:true});
  });
  // Le menu mobile se referme après le choix d’une page.
  document.querySelectorAll('.nav-mobile-panel a').forEach(function(a){
    a.addEventListener('click', function(){ var d=a.closest('details'); if(d) d.open=false; });
  });

  // ---------- Map (Leaflet + HILIA visual basemap, no external tiles) ----------
  var leafletMap = null, clusterGroup = null, markerByIdx = {}, validIdx = [], franceLayer = null;
  var FRANCE_CENTER = [46.6, 2.4];
  var FRANCE_GEOJSON = JSON.parse(document.getElementById('franceMapGeoJSON').textContent);

  for(var vi=0; vi<DATA.length; vi++){
    if(rDataHasCoords(DATA[vi])) validIdx.push(vi);
  }

  function rDataHasCoords(r){ return r[F.LAT]!=null && r[F.LON]!=null && r[F.LAT]!=='' && r[F.LON]!=='' && isFinite(Number(r[F.LAT])) && isFinite(Number(r[F.LON])); }

  function showMapUnavailable(){
    var empty=document.getElementById('mapEmpty');
    if(empty){
      empty.hidden=false;
      empty.innerHTML='<div class="empty-state" role="alert"><h3>La carte n’a pas pu être chargée</h3><p>La liste des lieux contient les mêmes informations et reste utilisable.</p><button type="button" class="primary-btn" data-map-list>Voir la liste</button></div>';
    }
  }
  // maplibre-gl-leaflet 0.1.4 appelle jumpTo() avant que _glMap soit prêt
  // lorsque Leaflet émet move/zoom pendant l'initialisation. On neutralise
  // uniquement ces mises à jour prématurées ; les appels normaux restent actifs.
  function guardMaplibreLeaflet(){
    if(typeof L==='undefined' || !L.MaplibreGL || !L.MaplibreGL.prototype) return;
    var proto=L.MaplibreGL.prototype;
    if(proto.__hiliaGuard) return;
    ['_update','_transformGL','_pinchZoom','_zoomEnd','_animateZoom','_transitionEnd'].forEach(function(name){
      var original=proto[name];
      if(typeof original!=='function') return;
      proto[name]=function(){
        if(!this._glMap) return;
        try { return original.apply(this, arguments); }
        catch(err){ console.warn('Fond de carte indisponible', err); }
      };
    });
    proto.__hiliaGuard=true;
  }
  function updateMapEmptyState(count){
    var empty=document.getElementById('mapEmpty'); if(!empty) return;
    if(count>0){ empty.hidden=true; return; }
    empty.hidden=false;
    empty.innerHTML='<div class="empty-state" role="status"><h3>Aucun lieu à afficher</h3><p>Modifiez la recherche ou les filtres, ou consultez la liste.</p><button type="button" class="primary-btn" data-map-list>Voir la liste</button></div>';
  }
  document.addEventListener('click', function(e){
    var btn=e.target.closest && e.target.closest('[data-map-list]');
    if(btn){ setListTab(); var heading=document.getElementById('resultsHeading'); if(heading) heading.focus({preventScroll:true}); }
  });
  function hardenBasemapA11y(){
    var root=document.getElementById('leafletMap'); if(!root) return;
    function patch(){
      root.querySelectorAll('.maplibregl-map, .maplibregl-canvas, .maplibregl-canvas-container').forEach(function(el){
        el.setAttribute('aria-hidden','true'); el.setAttribute('tabindex','-1'); el.removeAttribute('aria-label'); el.removeAttribute('role');
      });
      root.querySelectorAll('.maplibregl-control-container, .maplibregl-ctrl-attrib button').forEach(function(el){ el.setAttribute('aria-hidden','true'); el.setAttribute('tabindex','-1'); });
    }
    patch();
    if(window.MutationObserver){ var mo=new MutationObserver(patch); mo.observe(root,{childList:true,subtree:true}); setTimeout(function(){ mo.disconnect(); },10000); }
  }
  function initLeafletMap(){
    if(typeof L==='undefined' || !L.markerClusterGroup){ showMapUnavailable(); return; }
    leafletMap = L.map('leafletMap', {
      preferCanvas:true,
      minZoom:4,
      maxZoom:18,
      zoomControl:false,
      attributionControl:false,
      zoomAnimation:true,
      wheelDebounceTime:40,
      wheelPxPerZoomLevel:90
    }).setView(FRANCE_CENTER, 6);
    L.control.zoom({zoomInTitle:'Zoomer', zoomOutTitle:'Dézoomer'}).addTo(leafletMap);
    var mapContainer = leafletMap.getContainer();
    mapContainer.setAttribute('role','region');
    mapContainer.setAttribute('aria-label','Carte interactive des lieux');
    mapContainer.setAttribute('aria-describedby','mapHint');

    // Public vector basemap: much closer to the visual language users expect
    // from modern map apps than the previous flat GeoJSON-only background.
    // No API key is required. We keep the France geometry only to calculate the
    // initial/reset viewport and preserve the existing HILIA data markers.
    try{
      if(L.maplibreGL && window.maplibregl){
        guardMaplibreLeaflet();
        L.maplibreGL({
          style:'https://tiles.openfreemap.org/styles/positron',
          attributionControl:false
        }).addTo(leafletMap);
        hardenBasemapA11y();
      }
    }catch(err){ console.warn('Fond de carte indisponible', err); }

    franceLayer = L.geoJSON(FRANCE_GEOJSON, { interactive:false, style:{color:'#7DABA5',weight:1.2,fillColor:'#EAF2EE',fillOpacity:0.12}, className:'france-outline' });
    var bounds = franceLayer.getBounds();
    leafletMap.fitBounds(bounds.pad(0.08), {animate:false, paddingTopLeft:[20,20], paddingBottomRight:[20,20]});

    if(window.ResizeObserver){
      var mapRO = new ResizeObserver(function(){ if(leafletMap) leafletMap.invalidateSize({pan:false,animate:false}); });
      mapRO.observe(document.getElementById('mapCanvasWrap'));
    }
    window.addEventListener('orientationchange', function(){ setTimeout(function(){ if(leafletMap) leafletMap.invalidateSize({pan:false,animate:false}); },120); });

    clusterGroup = L.markerClusterGroup({
      maxClusterRadius:function(zoom){ return zoom >= 12 ? 42 : 54; },
      spiderfyOnMaxZoom:true,
      disableClusteringAtZoom:15,
      showCoverageOnHover:false,
      zoomToBoundsOnClick:true,
      iconCreateFunction:function(cluster){
        var n = cluster.getChildCount();
        var size = n<10?34:(n<100?40:48);
        return L.divIcon({
          html:'<div class="hilia-cluster" style="width:'+size+'px;height:'+size+'px;"><span aria-hidden="true">'+n.toLocaleString('fr-FR')+'</span><span class="sr-only">Groupe de '+n.toLocaleString('fr-FR')+' lieux, zoomer sur ce groupe</span></div>',
          className:'',
          iconSize:[size,size],
          iconAnchor:[size/2,size/2]
        });
      }
    });
    leafletMap.addLayer(clusterGroup);

    document.getElementById('mapReset').addEventListener('click', function(){
      leafletMap.invalidateSize({pan:false,animate:false});
      leafletMap.fitBounds(franceLayer.getBounds().pad(0.08), {animate:true,duration:0.5,paddingTopLeft:[20,20],paddingBottomRight:[20,20]});
    });
  }

  function pinIcon(color){
    return L.divIcon({
      className:'', iconSize:[18,18], iconAnchor:[9,17], popupAnchor:[0,-16],
      html:'<div class="hilia-pin" style="--pin-color:'+color+'"><i></i></div>'
    });
  }

  // Info-bulle et fenêtre construites au moment de l'ouverture, et non pour
  // chaque repère : les 54 350 fiches ne doivent pas être rendues à l'avance.
  function popupHtmlFor(di){
    var r = DATA[di];
    return '<div class="hilia-popup"><h4>'+escapeHtml(r[F.NOM])+'</h4><p>'+escapeHtml(COMMUNES[r[F.COM]])+' · '+r[F.CP]+'<br>'+escapeHtml(ACTIVITES[r[F.ACT]])+'</p><div class="popup-review">'+reviewSummaryHtml(di,'mini')+'</div><button type="button" data-di="'+di+'" aria-label="Voir la fiche de '+escapeAttr(r[F.NOM])+'">Voir la fiche</button></div>';
  }
  // Repères créés une seule fois puis réutilisés : sans ce cache, chaque
  // affichage de la carte reconstruisait les 54 350 repères, ce qui laissait
  // une carte presque vide le temps du remplissage.
  var markerCache = {};
  function markerFor(di){
    var cached = markerCache[di];
    if(cached) return cached;
    var r = DATA[di];
    var m = L.marker([Number(r[F.LAT]), Number(r[F.LON])], { icon: pinIcon(colorFor(r[F.ACT])) });
    m.on('add', function(){ var el = m.getElement && m.getElement(); if(el) el.setAttribute('aria-label', r[F.NOM]+', '+COMMUNES[r[F.COM]]+', '+ACTIVITES[r[F.ACT]]+' : ouvrir le résumé'); });
    m.bindTooltip(function(){ return r[F.NOM]+' · '+COMMUNES[r[F.COM]]; }, {direction:'top', offset:[0,-14]});
    m.bindPopup(function(){ return popupHtmlFor(di); });
    m.on('popupopen', function(e){
      var pop = e.popup.getElement();
      var cb = pop.querySelector('.leaflet-popup-close-button');
      if(cb){ cb.setAttribute('aria-label','Fermer la fenêtre d’information'); cb.setAttribute('title','Fermer la fenêtre d’information'); }
      var btn = pop.querySelector('button[data-di]');
      if(btn){ btn.addEventListener('click', function(){ openDetail(parseInt(btn.dataset.di,10)); }); btn.focus(); }
    });
    markerCache[di] = m;
    return m;
  }
  function drawMap(){
    if(!leafletMap || !clusterGroup) return;
    clusterGroup.clearLayers();
    markerByIdx = {};
    var showAll = filtered.length === DATA.length;
    var filteredSet = showAll ? null : new Set(filtered);
    var markers = [];
    var visibleBounds = [];
    for(var k=0;k<validIdx.length;k++){
      var di = validIdx[k];
      if(!showAll && !filteredSet.has(di)) continue;
      var m = markerFor(di);
      markerByIdx[di] = m;
      markers.push(m);
      visibleBounds.push([Number(DATA[di][F.LAT]),Number(DATA[di][F.LON])]);
    }
    clusterGroup.addLayers(markers);
    document.getElementById('mapHint').textContent = markers.length.toLocaleString('fr-FR')+(markers.length > 1 ? ' lieux affichés' : ' lieu affiché')+' · carte HILIA';
    updateMapEmptyState(markers.length);

    // When a search/filter isolates a small or off-mainland set, bring it into view.
    if(!showAll && visibleBounds.length && visibleBounds.length <= 2500){
      var b = L.latLngBounds(visibleBounds);
      if(b.isValid()) leafletMap.fitBounds(b.pad(0.12), {maxZoom:10, animate:false,paddingTopLeft:[30,30],paddingBottomRight:[30,30]});
    }
  }

  // Legend
  var legendEl = document.getElementById('mapLegend');
  Object.keys(TEMPLATE_LABEL).forEach(function(key){
    var span = document.createElement('li');
    span.innerHTML = '<i aria-hidden="true" style="background:'+TEMPLATE_COLOR[key]+'"></i>'+TEMPLATE_LABEL[key];
    legendEl.appendChild(span);
  });

  // ---------- Detail panel ----------
  var overlayBg = document.getElementById('overlayBg');
  var detailPanel = document.getElementById('detailPanel');
  var detailContent = document.getElementById('detailContent');
  function parseListField(s){ if(!s) return []; try{ var v=JSON.parse(s); return Array.isArray(v)?v:[s]; }catch(e){ return s?[s]:[]; } }
  var FAMILLE_LABELS = {moteur:'Handicap moteur', auditif:'Handicap auditif', visuel:'Handicap visuel', mental:'Handicap mental / psychique', th:'Tous handicaps (label)'};
  // Libellés publics des labels source. Les codes inconnus ne sont jamais
  // affichés bruts ; « autre » n'apporte aucune information exploitable.
  var LABEL_LABELS = {'th':'Tourisme & Handicap', handiplage:'Handiplage', mobalib:'Mobalib', dpt:'Destination pour tous'};
  function publicLabels(values){
    var out=[];
    (values || []).forEach(function(value){
      var label=LABEL_LABELS[String(value||'').toLowerCase()];
      if(label && out.indexOf(label)===-1) out.push(label);
    });
    return out;
  }
  function statusOf(v){ return isTrue(v) ? {c:'yes',g:'✓',t:'Oui'} : (isFalse(v) ? {c:'no',g:'✕',t:'Non'} : null); }
  function dItem(v,label){
    // Une donnée inconnue n’est ni affichée comme « non renseigné », ni présentée comme négative.
    var s=statusOf(v);
    if(!s) return '';
    return '<div class="d-item" role="listitem"><span class="dot '+s.c+'" aria-hidden="true">'+s.g+'</span><span class="d-label">'+label+'</span><span class="d-status">'+s.t+'</span></div>';
  }
  function dNum(label,value){ return '<div class="d-item" role="listitem"><span class="dot info" aria-hidden="true">i</span><span class="d-label">'+label+'</span><span class="d-status">'+escapeHtml(String(value))+'</span></div>'; }
  function escapeHtml(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function escapeAttr(s){ return escapeHtml(s); }

  // ---------- Local profile + reviews + permissions (prototype) ----------
  var profileState = null;
  var ROLE_DEFS = {
    user:{label:'Utilisateur',desc:'Peut publier des avis et suggérer des modifications.',perms:['Publier des avis','Suggérer une modification sur une fiche']},
    certified:{label:'Utilisateur certifié',desc:'Peut publier des avis, suggérer des corrections et proposer de nouveaux lieux, soumis à validation.',perms:['Publier des avis','Suggérer des modifications','Proposer un nouveau lieu (validation Admin)']},
    admin:{label:'Admin',desc:'Gère les données et la modération de la plateforme.',perms:['Publier des avis','Suggérer des modifications','Ajouter des activités et des lieux','Modifier les informations des fiches','Valider ou refuser les propositions','Modérer ou supprimer des avis']}
  };
  function roleOf(p){ return p && ROLE_DEFS[p.role] ? p.role : 'user'; }
  function roleDef(p){ return ROLE_DEFS[roleOf(p)]; }
  function getProfile(){ try{ var p=JSON.parse(localStorage.getItem(PROFILE_KEY)||'null'); if(p) { p.role=roleOf(p); } return p; }catch(e){ return null; } }
  // ---------- Avis ----------
  // Les avis sont chargés pour les fiches réellement affichées (page courante, fiche
  // ouverte) et non plus par une requête globale que l'API tronquait à 1 000 lignes.
  // Chaque avis est rattaché à l'identifiant réel de la fiche.
  var reviewsByPlace = {};   // { idFiche: [avis] }
  var reviewsLoaded = {};    // { idFiche: true } une fois la réponse obtenue
  var reviewsPending = {};   // { idFiche: true } pendant la requête en cours
  function reviewsFor(di){ var ref=placeRef(di); return (ref && reviewsByPlace[ref]) || []; }
  function reviewRow(row){
    return {id:row.id,user_id:row.user_id,name:row.author_name,email:'',rating:row.rating,comment:row.comment,date:row.created_at};
  }
  async function fetchReviews(refs){
    var missing=[];
    refs.forEach(function(ref){ ref=ref==null?'':String(ref); if(ref && !reviewsLoaded[ref] && !reviewsPending[ref] && missing.indexOf(ref)<0) missing.push(ref); });
    if(!missing.length || !supabaseClient) return false;
    missing.forEach(function(ref){ reviewsPending[ref]=true; });
    var result=await supabaseClient.from('hilia_reviews').select('id,place_id,user_id,author_name,rating,comment,created_at').in('place_id',missing).order('created_at',{ascending:false});
    if(result.error){
      console.warn('Chargement des avis impossible',result.error.message);
      missing.forEach(function(ref){ delete reviewsPending[ref]; });
      return false;
    }
    (result.data||[]).forEach(function(row){
      var key=String(row.place_id);
      if(missing.indexOf(key)<0) return;
      (reviewsByPlace[key] || (reviewsByPlace[key]=[])).push(reviewRow(row));
    });
    // La réponse couvre toutes les fiches demandées, y compris celles sans avis.
    missing.forEach(function(ref){ reviewsLoaded[ref]=true; delete reviewsPending[ref]; });
    return true;
  }
  function invalidateReviews(ref){ ref=ref==null?'':String(ref); if(!ref) return; delete reviewsByPlace[ref]; delete reviewsLoaded[ref]; delete reviewsPending[ref]; }
  function ensureReviews(indices, then){
    var refs=indices.map(placeRef).filter(Boolean);
    return fetchReviews(refs).then(function(loaded){ if(loaded && typeof then==='function') then(); return loaded; });
  }
  // Avis publiés par la personne connectée (page profil).
  var myReviews=null, myReviewsFor=null;
  async function loadMyReviews(userId){
    if(!supabaseClient || !userId){ myReviews=null; myReviewsFor=null; return; }
    if(myReviewsFor===userId) return;
    var result=await supabaseClient.from('hilia_reviews').select('id,place_id,author_name,rating,comment,created_at').eq('user_id',userId).order('created_at',{ascending:false});
    if(result.error){ console.warn('Chargement de vos avis impossible',result.error.message); return; }
    myReviewsFor=userId;
    myReviews=(result.data||[]).map(function(row){
      return {di:indexFromPlaceRef(row.place_id), review:{name:row.author_name,user_id:userId,rating:row.rating,comment:row.comment,date:row.created_at}};
    });
  }
  function getPendingPlaces(){ try{ var v=JSON.parse(localStorage.getItem(PENDING_PLACES_KEY)||'[]'); return Array.isArray(v)?v:[]; }catch(e){ return []; } }
  function getApprovedPlaces(){ try{ var v=JSON.parse(localStorage.getItem(APPROVED_PLACES_KEY)||'[]'); return Array.isArray(v)?v:[]; }catch(e){ return []; } }
  function getEdits(){ try{ var v=JSON.parse(localStorage.getItem(EDITS_KEY)||'{}'); return v && typeof v==='object'?v:{}; }catch(e){ return {}; } }
  // Synchronise lieux validés, propositions (admin), modifications de fiches et activités depuis Supabase.
  // Les données sont mises en cache dans le navigateur ; la page se recharge une fois si elles ont changé.
  async function loadRemoteContent(){
    if(!supabaseClient) return false;
    try{
      var p=getProfile(), isAdm=!!p && roleOf(p)==='admin';
      var selP='id,name,activity,address,cp,commune,site,lat,lon,reason,author,author_name,status,created_at,approved_at', selE='place_id,name,address,cp,commune,activity,site';
      var res=await Promise.all([
        supabaseClient.from('hilia_places').select(selP+',access,qualif').is('data_origin',null),
        supabaseClient.from('hilia_place_edits').select(selE+',access').order('place_id'),
        supabaseClient.from('hilia_activities').select('name,created_at').order('created_at',{ascending:true})
      ]);
      if(res[0].error && /access|qualif/i.test(res[0].error.message)) res[0]=await supabaseClient.from('hilia_places').select(selP).is('data_origin',null);
      if(res[1].error && /access/i.test(res[1].error.message)) res[1]=await supabaseClient.from('hilia_place_edits').select(selE).order('place_id');
      var changed=false;
      function put(key,val){ var s=JSON.stringify(val); if(localStorage.getItem(key)!==s){ localStorage.setItem(key,s); return true; } return false; }
      function ts(r){ var t=Date.parse(r.approved_at||r.created_at); return isNaN(t)?0:t; }
      function toLocal(r){ return {id:r.id,name:r.name,activity:r.activity,address:r.address,cp:r.cp,commune:r.commune,site:r.site||'',lat:r.lat==null?'':String(r.lat),lon:r.lon==null?'':String(r.lon),reason:r.reason||'',author:r.author||'',authorName:r.author_name,date:r.created_at,access:(r.access&&typeof r.access==='object')?r.access:null,qualif:(r.qualif&&typeof r.qualif==='object')?r.qualif:null}; }
      if(!res[0].error){
        var rows=res[0].data||[];
        var approved=rows.filter(function(r){return r.status==='approved';}).sort(function(a,b){ return ts(a)-ts(b) || String(a.id).localeCompare(String(b.id)); }).map(toLocal);
        var pending=isAdm ? rows.filter(function(r){return r.status==='pending';}).sort(function(a,b){return Date.parse(b.created_at)-Date.parse(a.created_at);}).map(toLocal) : [];
        if(put(APPROVED_PLACES_KEY,approved)) changed=true;
        put(PENDING_PLACES_KEY,pending);
      } else console.warn('Chargement des lieux impossible',res[0].error.message);
      if(!res[1].error){
        var edits={}; (res[1].data||[]).forEach(function(r){ edits[r.place_id]={name:r.name,address:r.address,cp:r.cp,commune:r.commune,activity:r.activity,site:r.site,access:(r.access&&typeof r.access==='object')?r.access:null}; });
        if(put(EDITS_KEY,edits)) changed=true;
      } else console.warn('Chargement des modifications impossible',res[1].error.message);
      if(!res[2].error){
        var acts=(res[2].data||[]).map(function(r){return r.name;});
        getCustomActivitiesEarly().forEach(function(a){ if(acts.indexOf(a)<0) acts.push(a); });
        if(put(CUSTOM_ACTIVITIES_KEY,acts)) changed=true;
      } else console.warn('Chargement des activités impossible',res[2].error.message);
      if(changed){
        var n=Number(sessionStorage.getItem('hilia_sync_n')||0);
        if(n<2){ sessionStorage.setItem('hilia_sync_n',String(n+1)); location.reload(); return true; }
      } else sessionStorage.removeItem('hilia_sync_n');
    }catch(err){ console.warn('Synchronisation impossible',err); }
    return false;
  }
  async function loadRemoteSuggestions(){
    if(!supabaseClient) return;
    var p=getProfile();
    if(!p || roleOf(p)!=='admin'){ localStorage.removeItem(SUGGESTIONS_KEY); return; }
    var result=await supabaseClient.from('hilia_suggestions').select('id,place_id,suggestion_text,author_email,author_name,status,created_at').order('created_at',{ascending:false});
    if(result.error){ console.warn('Chargement des suggestions impossible',result.error.message); return; }
    var list=(result.data||[]).map(function(row){ return {id:row.id,ref:String(row.place_id),di:indexFromPlaceRef(row.place_id),text:row.suggestion_text,author:row.author_email,authorName:row.author_name,date:row.created_at,status:row.status}; });
    localStorage.setItem(SUGGESTIONS_KEY,JSON.stringify(list));
  }
  function getSuggestions(){ try{ var v=JSON.parse(localStorage.getItem(SUGGESTIONS_KEY)||'[]'); return Array.isArray(v)?v:[]; }catch(e){ return []; } }
  function reviewListFor(di){ return reviewsFor(di); }
  function reviewSummary(di){ var list=reviewListFor(di), sum=0; list.forEach(function(x){ sum += Number(x.rating)||0; }); return {count:list.length, avg:list.length ? sum/list.length : 0}; }
  function starsHtml(rating){ var n=Math.max(0,Math.min(5,Math.round(Number(rating)||0))), out=''; for(var i=1;i<=5;i++) out += i<=n ? '★' : '☆'; return '<span class="stars" role="img" aria-label="Note : '+n+' sur 5">'+out+'</span>'; }
  function reviewSummaryHtml(di, mode){ var s=reviewSummary(di); if(!s.count) return mode==='mini' ? '<span style="color:var(--muted);font-weight:600">Pas encore d’avis</span>' : '<span style="color:var(--muted);font-weight:600">Aucun avis pour le moment</span>'; if(mode==='mini') return starsHtml(s.avg)+' <span>'+s.avg.toFixed(1).replace('.',',')+' ('+s.count+')</span>'; return starsHtml(s.avg)+' <span>'+s.avg.toFixed(1).replace('.',',')+' / 5 · '+s.count+' avis</span>'; }
  var profileAuthMode='login';
  function setProfileMode(mode, preserveStatus){
    profileAuthMode = mode==='register' ? 'register' : 'login';
    var passwordField=document.getElementById('profilePassword'); if(passwordField) passwordField.setAttribute('autocomplete',profileAuthMode==='register'?'new-password':'current-password');
    var buttons=document.querySelectorAll('[data-auth-mode]'); buttons.forEach(function(b){ b.classList.toggle('active', b.dataset.authMode===profileAuthMode); b.setAttribute('aria-pressed', b.dataset.authMode===profileAuthMode ? 'true' : 'false'); });
    var nameField=document.getElementById('profileNameField'), nameEl=document.getElementById('profileName'), title=document.getElementById('profileFormTitle'), intro=document.getElementById('profileFormIntro'), submit=document.getElementById('profileSubmitBtn');
    var logged=!!getProfile();
    if(profileAuthMode==='register'){
      title.textContent='Créer votre profil';
      intro.textContent='Créez un compte HILIA pour publier et retrouver vos avis.';
      nameField.style.display=''; nameEl.required=true; nameEl.disabled=false;
      submit.textContent='Créer mon profil';
    }else{
      title.textContent='Se connecter';
      intro.textContent=logged ? 'Connectez-vous avec votre compte HILIA.' : 'Vous pouvez créer un compte HILIA en quelques secondes.';
      nameField.style.display=logged ? 'none' : 'none'; nameEl.required=false; nameEl.disabled=true;
      submit.textContent='Se connecter';
    }
    if(!preserveStatus) document.getElementById('profileFormStatus').textContent='';
  }
  function profileFormError(msg, field){
    var st=document.getElementById('profileFormStatus'); if(st) st.textContent=msg;
    ['profileName','profileEmail','profilePassword'].forEach(function(id){ var el=document.getElementById(id); if(el) el.removeAttribute('aria-invalid'); });
    if(field){ field.setAttribute('aria-invalid','true'); field.focus(); }
  }
  // Récupère le rôle enregistré dans Supabase. La politique RLS doit limiter
  // cette lecture au rôle du compte actuellement connecté.
  async function fetchSupabaseRole(userId){
    if(!supabaseClient || !userId) return 'user';
    try{
      var result = await supabaseClient
        .from('hilia_user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle();
      if(result.error){
        console.warn('Lecture du rôle Supabase impossible', result.error.message);
        return 'user';
      }
      return result.data && ['user','admin','certified'].includes(result.data.role)
        ? result.data.role
        : 'user';
    }catch(err){
      console.warn('Lecture du rôle Supabase impossible', err);
      return 'user';
    }
  }

  // Activation du sélecteur connexion / création de compte.
  document.querySelectorAll('[data-auth-mode]').forEach(function(button){
    button.addEventListener('click', function(){
      setProfileMode(button.dataset.authMode);
    });
  });
  setProfileMode('login', true);

  var profileForm=document.getElementById('profileForm');
  if(profileForm) profileForm.addEventListener('input', function(e){ if(e.target && e.target.removeAttribute) e.target.removeAttribute('aria-invalid'); });
  if(profileForm){
    profileForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var name=(document.getElementById('profileName')?.value||'').trim();
      var email=(document.getElementById('profileEmail')?.value||'').trim().toLowerCase();
      var password=document.getElementById('profilePassword')?.value||'';
      var status=document.getElementById('profileFormStatus');
      if(!supabaseClient){ profileFormError('Le service de compte ne se charge pas. Vérifiez votre connexion puis rechargez la page.'); return; }
      if(!email && !passwordRecoveryMode){ profileFormError('Renseignez votre adresse e-mail.', document.getElementById('profileEmail')); return; }
      if(passwordRecoveryMode){
        if(password.length<6){ profileFormError('Le nouveau mot de passe doit contenir au moins 6 caractères.',document.getElementById('profilePassword')); return; }
        var recoverySubmit=document.getElementById('profileSubmitBtn'); recoverySubmit.disabled=true;
        try{
          var updateResult=await supabaseClient.auth.updateUser({password:password});
          if(updateResult.error) throw updateResult.error;
          passwordRecoveryMode=false;
          if(status) status.textContent='Votre mot de passe a été modifié. Vous pouvez maintenant utiliser ce nouveau mot de passe.';
          announce('Mot de passe modifié avec succès.');
          document.getElementById('profilePassword').value='';
          setProfileMode('login',true);
          if(forgotPasswordBtn) forgotPasswordBtn.style.display='';
          var emailField=document.getElementById('profileEmailField'); if(emailField) emailField.style.display='';
          var emailInput=document.getElementById('profileEmail'); if(emailInput) emailInput.required=true;
          var authSwitch=document.querySelector('.auth-switch'); if(authSwitch) authSwitch.style.display='';
          var recoveryIntro=document.getElementById('profileFormIntro'); if(recoveryIntro) recoveryIntro.textContent='Votre mot de passe a été modifié. Connectez-vous avec votre nouveau mot de passe.';
        }catch(err){
          var recoveryMsg=(err&&err.message)||'Impossible de modifier le mot de passe.';
          if(/weak password|at least \d+ characters/i.test(recoveryMsg)) recoveryMsg='Le mot de passe doit contenir au moins 6 caractères.';
          else recoveryMsg='Impossible de modifier le mot de passe. Le lien est peut-être expiré : demandez un nouvel e-mail de réinitialisation.';
          if(status) status.textContent=recoveryMsg; announce(recoveryMsg);
        }finally{recoverySubmit.disabled=false;}
        return;
      }
      if(!password){ profileFormError('Renseignez votre mot de passe.',document.getElementById('profilePassword')); return; }
      if(profileAuthMode==='register' && name.length<2){ profileFormError('Indiquez un nom affiché de 2 caractères minimum.', document.getElementById('profileName')); return; }
      if(profileAuthMode==='register' && password.length<6){ profileFormError('Le mot de passe doit contenir au moins 6 caractères.', document.getElementById('profilePassword')); return; }
      var submit=document.getElementById('profileSubmitBtn'); submit.disabled=true;
      try{
        var result;
        if(profileAuthMode==='register'){
          result=await supabaseClient.auth.signUp({email:email,password:password,options:{data:{display_name:name}}});
          if(result.error) throw result.error;
          if(result.data.session){
            profileState={id:result.data.user.id,name:name,email:email,role:'user'};
            localStorage.setItem(PROFILE_KEY,JSON.stringify(profileState));
            if(status) status.textContent='Compte créé et connecté. Vous pouvez maintenant publier des avis.'; announce('Compte créé et connexion réussie. Vous pouvez maintenant publier des avis.');
          }else{
            if(status) status.textContent='Compte créé. Consultez votre boîte e-mail pour confirmer votre adresse, puis connectez-vous.'; announce('Compte créé. Consultez votre boîte e-mail pour confirmer votre adresse avant de vous connecter.');
          }
        }else{
          result=await supabaseClient.auth.signInWithPassword({email:email,password:password});
          if(result.error) throw result.error;
          var user=result.data.user, meta=(user.user_metadata||{});
          var assignedRole = await fetchSupabaseRole(user.id);
          profileState={id:user.id,name:meta.display_name||email.split('@')[0],email:user.email,role:assignedRole};
          localStorage.setItem(PROFILE_KEY,JSON.stringify(profileState));
          if(status) status.textContent='Connexion réussie.'; announce('Connexion réussie. Bienvenue sur HILIA.');
        }
        if(profileState){ if(await loadRemoteContent()) return; await loadRemoteSuggestions(); renderProfilePage(); refreshReviewMinis(); }
      }catch(err){
        var msg=(err && err.message)||'Une erreur est survenue.';
        if(/already registered|already exists/i.test(msg)) msg='Un compte existe déjà avec cette adresse. Essayez de vous connecter.';
        else if(/invalid login credentials/i.test(msg)) msg='Adresse e-mail ou mot de passe incorrect.';
        else if(/email not confirmed/i.test(msg)) msg='Confirmez votre adresse e-mail avant de vous connecter.';
        else if(/at least \d+ characters|weak password/i.test(msg)) msg='Mot de passe trop faible : utilisez au moins 6 caractères.';
        else if(/rate limit|too many|over_email_send_rate_limit/i.test(msg)) msg='Trop de tentatives. Patientez quelques minutes avant de réessayer.';
        else if(/invalid.*email|unable to validate email/i.test(msg)) msg='Cette adresse e-mail n’est pas valide.';
        else if(/failed to fetch|network/i.test(msg)) msg='Connexion impossible. Vérifiez votre réseau puis réessayez.';
        if(status) status.textContent=msg; announce(msg);
      }finally{ submit.disabled=false; }
    });
  }

  // Réinitialisation du mot de passe via le lien sécurisé envoyé par Supabase.
  var passwordRecoveryMode=false;
  var forgotPasswordBtn=document.getElementById('forgotPasswordBtn');
  if(forgotPasswordBtn) forgotPasswordBtn.addEventListener('click', async function(){
    var email=(document.getElementById('profileEmail')?.value||'').trim().toLowerCase();
    var status=document.getElementById('profileFormStatus');
    if(!supabaseClient){ profileFormError('Le service de compte ne se charge pas. Rechargez la page puis réessayez.'); return; }
    if(!email){ profileFormError('Saisissez votre adresse e-mail, puis cliquez sur « Mot de passe oublié ? ».',document.getElementById('profileEmail')); return; }
    if(!/^\S+@\S+\.\S+$/.test(email)){ profileFormError('Cette adresse e-mail ne semble pas valide.',document.getElementById('profileEmail')); return; }
    forgotPasswordBtn.disabled=true;
    try{
      var redirectUrl=window.location.origin+window.location.pathname+'#profile';
      var result=await supabaseClient.auth.resetPasswordForEmail(email,{redirectTo:redirectUrl});
      if(result.error) throw result.error;
      var msg='Si un compte correspond à cette adresse, un e-mail de réinitialisation vient d’être envoyé. Consultez aussi vos courriers indésirables.';
      if(status) status.textContent=msg; announce(msg);
    }catch(err){
      var msg=(err&&err.message)||'Impossible d’envoyer l’e-mail de réinitialisation.';
      if(/rate limit|too many|over_email_send_rate_limit/i.test(msg)) msg='Trop de demandes. Patientez quelques minutes avant de réessayer.';
      else if(/failed to fetch|network/i.test(msg)) msg='Envoi impossible. Vérifiez votre connexion puis réessayez.';
      else msg='Impossible d’envoyer l’e-mail de réinitialisation. Vérifiez la configuration e-mail de Supabase puis réessayez.';
      if(status) status.textContent=msg; announce(msg);
    }finally{forgotPasswordBtn.disabled=false;}
  });

  function activatePasswordRecoveryUI(){
    passwordRecoveryMode=true;
    setProfileMode('login',true);
    var title=document.getElementById('profileFormTitle');
    var intro=document.getElementById('profileFormIntro');
    var password=document.getElementById('profilePassword');
    var submit=document.getElementById('profileSubmitBtn');
    var status=document.getElementById('profileFormStatus');
    navigatePage('profile',false);
    var authSwitch=document.querySelector('.auth-switch'); if(authSwitch) authSwitch.style.display='none';
    var emailField=document.getElementById('profileEmailField'); if(emailField) emailField.style.display='none';
    var emailInput=document.getElementById('profileEmail'); if(emailInput) emailInput.required=false;
    if(title) title.textContent='Choisir un nouveau mot de passe';
    if(intro) intro.textContent='Saisissez le nouveau mot de passe de votre compte HILIA.';
    if(password){password.value='';password.setAttribute('autocomplete','new-password');password.setAttribute('placeholder','Nouveau mot de passe');}
    if(submit) submit.textContent='Enregistrer le nouveau mot de passe';
    if(forgotPasswordBtn) forgotPasswordBtn.style.display='none';
    if(status) status.textContent='Lien de réinitialisation détecté. Saisissez votre nouveau mot de passe.';
    announce('Saisissez votre nouveau mot de passe.');
  }

  if(supabaseClient && supabaseClient.auth && supabaseClient.auth.onAuthStateChange){
    supabaseClient.auth.onAuthStateChange(function(event){
      if(event==='PASSWORD_RECOVERY'){
        // Différer les manipulations d'interface hors du callback Supabase.
        setTimeout(activatePasswordRecoveryUI,0);
      }
    });
  }
  // Le SDK peut traiter le lien avant que l'écouteur PASSWORD_RECOVERY soit installé.
  // Le marqueur capturé au chargement permet alors d'afficher quand même le formulaire.
  if(initialPasswordRecoveryLink){
    Promise.resolve(supabaseClient && supabaseClient.auth ? supabaseClient.auth.getSession() : null)
      .catch(function(){ return null; })
      .then(function(){ activatePasswordRecoveryUI(); });
  }

  var logoutBtn=document.getElementById('profileLogoutBtn');
  if(logoutBtn) logoutBtn.addEventListener('click',async function(){
    if(!supabaseClient) return;
    var status=document.getElementById('profileFormStatus');
    try{ var result=await supabaseClient.auth.signOut(); if(result.error) throw result.error; }
    catch(err){ if(status) status.textContent='Impossible de se déconnecter pour le moment.'; announce('Impossible de se déconnecter pour le moment. Réessayez.'); return; }
    profileState=null; myReviews=null; myReviewsFor=null; localStorage.removeItem(PROFILE_KEY); localStorage.removeItem(PENDING_PLACES_KEY); localStorage.removeItem(SUGGESTIONS_KEY); renderProfilePage();
    if(status) status.textContent='Vous êtes déconnecté.'; announce('Vous êtes déconnecté de votre compte HILIA.');
  });

  async function restoreSupabaseSession(){
    if(!supabaseClient) return;
    try{
      var result=await supabaseClient.auth.getSession();
      if(result.error) throw result.error;
      var session=result.data.session;
      if(session && session.user){
        var u=session.user, meta=u.user_metadata||{};
        var assignedRole = await fetchSupabaseRole(u.id);
        profileState={id:u.id,name:meta.display_name||(u.email||'').split('@')[0],email:u.email,role:assignedRole};
        localStorage.setItem(PROFILE_KEY,JSON.stringify(profileState));
      }else{
        profileState=null; localStorage.removeItem(PROFILE_KEY);
      }
      if(await loadRemoteContent()) return;
      await loadRemoteSuggestions();
      renderProfilePage(); refreshReviewMinis();
    }catch(err){ console.warn('Initialisation Supabase impossible',err); }
  }

  function rolePillHtml(role){ var d=ROLE_DEFS[role]||ROLE_DEFS.user; return '<span class="role-pill '+(role==='admin'?'admin':role==='certified'?'certified':'')+'"><span class="role-dot"></span><span>'+d.label+'</span></span>'; }
  function rolePermissionsHtml(role){ var d=ROLE_DEFS[role]||ROLE_DEFS.user, html='<div class="page-card" style="margin-top:18px"><h2>Vos droits</h2><p style="color:var(--muted);margin:0 0 8px">'+d.desc+'</p><ul class="permission-list">'; d.perms.forEach(function(p){ html+='<li>'+escapeHtml(p)+'</li>'; }); html+='</ul><p style="margin:12px 0 0;color:var(--muted);font-size:.75rem">Hiérarchie : Utilisateur → Utilisateur certifié → Admin.</p></div>'; return html; }
  function renderProfilePage(){
    profileState=getProfile();
    var nameEl=document.getElementById('profileName'), emailEl=document.getElementById('profileEmail'), passEl=document.getElementById('profilePassword');
    var summaryTitle=document.getElementById('profileSummaryTitle'), summaryText=document.getElementById('profileSummaryText'), logout=document.getElementById('profileLogoutBtn');
    var rolePill=document.getElementById('profileRolePill'), prototypeBox=document.getElementById('prototypeRoleBox'), roleSelect=document.getElementById('prototypeRoleSelect');
    if(profileState){
      nameEl.value=profileState.name||''; emailEl.value=profileState.email||''; passEl.value='';
      var rr=roleOf(profileState); rolePill.innerHTML=rolePillHtml(rr); summaryTitle.textContent='Bonjour '+(profileState.name||''); summaryText.textContent=profileState.email||''; logout.style.display='inline-flex';
      roleSelect.value='user'; prototypeBox.style.display='none'; setProfileMode('login', true);
      document.getElementById('profilePermissions').innerHTML=rolePermissionsHtml(rr);
    } else {
      nameEl.value=''; emailEl.value=''; passEl.value=''; rolePill.innerHTML=rolePillHtml('user'); summaryTitle.textContent='Pas encore connecté'; summaryText.textContent='Créez un compte HILIA pour publier des avis sur les lieux.'; logout.style.display='none'; prototypeBox.style.display='none'; setProfileMode('login', true);
      document.getElementById('profilePermissions').innerHTML=rolePermissionsHtml('user');
    }
    renderContributionArea(); renderAdminArea();
    renderMyReviews();
    if(profileState) loadMyReviews(profileState.id).then(function(){ if(getProfile()) renderMyReviews(); });
  }
  // « Mes avis » : récupérés directement depuis Supabase pour la personne connectée.
  function renderMyReviews(){
    var count=document.getElementById('profileReviewCount'), holder=document.getElementById('profileMyReviews');
    if(!holder) return;
    if(!getProfile()){ if(count) count.textContent='0'; holder.innerHTML=''; return; }
    if(myReviews===null){
      if(count) count.textContent='…';
      holder.innerHTML='<div class="page-card profile-reviews"><h2>Mes avis</h2><p>Chargement de vos avis…</p></div>';
      return;
    }
    if(count) count.textContent=myReviews.length.toLocaleString('fr-FR');
    if(!myReviews.length){ holder.innerHTML='<div class="page-card profile-reviews"><h2>Mes avis</h2><p>Vous n’avez encore publié aucun avis.</p></div>'; return; }
    var out='<div class="page-card profile-reviews"><h2>Mes avis</h2><div class="review-list">';
    myReviews.forEach(function(item){
      var r=item.di>=0?DATA[item.di]:null, nom=r?r[F.NOM]:'Fiche retirée';
      out+='<article class="review-item"><div class="review-item-top">'
        + (r?'<button type="button" class="profile-review-link" data-profile-review-index="'+item.di+'">'+escapeHtml(nom)+'</button>':'<strong>'+escapeHtml(nom)+'</strong>')
        + '<span class="review-date">'+formatDate(item.review.date)+'</span></div>'
        + '<div>'+starsHtml(item.review.rating)+'</div>'
        + '<div class="review-comment">'+escapeHtml(item.review.comment||'')+'</div></article>';
    });
    out+='</div></div>'; holder.innerHTML=out;
    holder.querySelectorAll('[data-profile-review-index]').forEach(function(btn){ btn.addEventListener('click',function(){ navigatePage('explore'); setListTab(); openDetail(parseInt(btn.dataset.profileReviewIndex,10)); }); });
  }
  function renderContributionArea(){
    var box=document.getElementById('profileContributionArea'); if(!box) return; var p=profileState, rr=roleOf(p);
    if(!p){ box.innerHTML=''; return; }
    var html='';
    if(rr==='certified' || rr==='admin'){
      var isAdmin=rr==='admin';
      html+='<div class="contrib-panel"><h2>'+(isAdmin?'Ajouter un nouveau lieu':'Proposer un nouveau lieu')+'</h2><p style="margin:0;color:var(--muted);font-size:.83rem;line-height:1.5">'+(isAdmin?'Le lieu sera ajouté directement à l’annuaire.':'Votre proposition sera placée en attente de validation Admin avant d’apparaître dans l’annuaire.')+'</p><form id="newPlaceForm" class="inline-form"><div class="inline-form-grid"><div class="field"><label for="newPlaceName">Nom du lieu</label><input id="newPlaceName" name="name" required placeholder="Ex. Médiathèque HILIA"></div><div class="field"><label for="newPlaceActivity">Activité</label><select id="newPlaceActivity" name="activity" required><option value="">Choisir…</option>'+ACTIVITES.map(function(a){return '<option>'+escapeHtml(a)+'</option>';}).join('')+'</select></div><div class="field"><label for="newPlaceAddress">Adresse</label><input id="newPlaceAddress" name="address" required></div><div class="field"><label for="newPlaceCp">Code postal</label><input id="newPlaceCp" name="cp" required inputmode="numeric"></div><div class="field"><label for="newPlaceCommune">Commune</label><input id="newPlaceCommune" name="commune" required list="communesList"></div><div class="field"><label for="newPlaceSite">Site internet</label><input id="newPlaceSite" name="site" type="url" placeholder="https://…"></div><div class="field"><label for="newPlaceLat">Latitude (optionnel)</label><input id="newPlaceLat" name="lat" inputmode="decimal"></div><div class="field"><label for="newPlaceLon">Longitude (optionnel)</label><input id="newPlaceLon" name="lon" inputmode="decimal"></div>'+accessFormHtml('new',null)+'<div class="field full"><label for="newPlaceReason">Pourquoi ajouter ce lieu ?</label><textarea id="newPlaceReason" name="reason" maxlength="1000" placeholder="Quelques mots pour aider l’Admin à vérifier votre proposition…"></textarea></div></div><button class="primary-btn" type="submit" style="margin-top:10px">Soumettre le lieu</button><div class="auth-note" id="newPlaceStatus"></div></form></div>';
    }
    html+='<div class="contrib-panel"><h2>Suggérer une correction</h2><p style="margin:0;color:var(--muted);font-size:.83rem;line-height:1.5">Les suggestions restent en attente et doivent être vérifiées avant modification de la fiche.</p></div>';
    box.innerHTML=html;
    var form=document.getElementById('newPlaceForm');
    if(form) form.addEventListener('submit',async function(e){
      e.preventDefault(); var fd=new FormData(form); var latValue=fd.get('lat').trim(), lonValue=fd.get('lon').trim(); if(latValue!=='' && (!isFinite(Number(latValue)) || Number(latValue)<-90 || Number(latValue)>90)){document.getElementById('newPlaceStatus').textContent='Latitude invalide.';return;} if(lonValue!=='' && (!isFinite(Number(lonValue)) || Number(lonValue)<-180 || Number(lonValue)>180)){document.getElementById('newPlaceStatus').textContent='Longitude invalide.';return;} var payload={id:'place_'+Date.now(),name:fd.get('name').replace(/[\u2014\u2013]/g,' ').replace(/\s+/g,' ').trim(),activity:fd.get('activity'),address:fd.get('address').trim(),cp:fd.get('cp').trim(),commune:fd.get('commune').trim(),site:safeExternalUrl(fd.get('site')),lat:fd.get('lat').trim(),lon:fd.get('lon').trim(),reason:fd.get('reason').trim(),author:p.email,authorName:p.name,date:new Date().toISOString()}; var isAdm=roleOf(p)==='admin', stEl=document.getElementById('newPlaceStatus'), rnd=Date.now()+'_'+Math.random().toString(16).slice(2);
      var geo=null; if(payload.lat==='' || payload.lon===''){ geo=await provGeocode([payload.address,payload.cp,payload.commune,'France'].filter(Boolean).join(', ')); } var row={id:(isAdm?'place_':'pending_')+rnd,name:payload.name,activity:payload.activity,address:payload.address,cp:(payload.cp||(geo&&geo.cp)||''),commune:(payload.commune||(geo&&geo.commune)||''),site:payload.site||null,lat:payload.lat!==''?Number(payload.lat):(geo?geo.lat:null),lon:payload.lon!==''?Number(payload.lon):(geo?geo.lon:null),reason:payload.reason||null,author:isAdm?null:p.email,author_name:p.name||String(p.email||'').split('@')[0],status:isAdm?'approved':'pending',approved_at:isAdm?new Date().toISOString():null,access:readAccess(fd)};
      var ins=await supabaseClient.from('hilia_places').insert(row);
      if(ins.error){ console.error('Enregistrement du lieu impossible',ins.error); stEl.textContent='Impossible d’enregistrer le lieu : '+ins.error.message; return; }
      if(isAdm){ stEl.textContent='Lieu ajouté à l’annuaire.'; await loadRemoteContent(); location.reload(); }
      else { stEl.textContent='Proposition enregistrée et mise en attente de validation Admin.'; form.reset(); }
    });
  }
  function renderAdminArea(){
    var box=document.getElementById('profileAdminArea'); if(!box) return; if(!profileState || roleOf(profileState)!=='admin'){ box.innerHTML=''; return; }
    var pending=getPendingPlaces(), suggestions=getSuggestions();
    var html='<div class="admin-panel"><h2>Administration</h2><p style="margin:0;color:var(--muted);font-size:.83rem">Zone réservée aux administrateurs : les actions ci-dessous sont enregistrées dans la base de données.</p>';
    html+='<h3>Propositions de nouveaux lieux ('+pending.length+')</h3><div class="admin-list">';
    if(!pending.length) html+='<div class="admin-item"><div class="admin-item-main"><strong>Aucune proposition en attente</strong><p>Les nouveaux lieux proposés par les utilisateurs certifiés apparaîtront ici.</p></div></div>';
    pending.forEach(function(p){ html+='<div class="admin-item"><div class="admin-item-main"><strong>'+escapeHtml(p.name)+' · '+escapeHtml(p.activity)+'</strong><p>'+escapeHtml(p.address)+', '+escapeHtml(p.cp)+' '+escapeHtml(p.commune)+'<br>'+escapeHtml(p.reason||'Aucune précision.')+accSummary(p)+'<br><small>'+escapeHtml(p.authorName||p.author||'Utilisateur')+' · '+formatDate(p.date)+'</small></p></div><div class="admin-item-actions"><button class="small-btn primary" type="button" aria-label="Valider la proposition « '+escapeAttr(p.name)+' »" data-approve-place="'+p.id+'">Valider</button><button class="small-btn danger" type="button" aria-label="Refuser la proposition « '+escapeAttr(p.name)+' »" data-reject-place="'+p.id+'">Refuser</button></div></div>'; });
    html+='</div>';
    html+='<h3>Suggestions de modifications ('+suggestions.filter(function(s){return s.status!=="done";}).length+')</h3><div class="admin-list">';
    var openSug=suggestions.filter(function(s){return s.status!=="done";});
    if(!openSug.length) html+='<div class="admin-item"><div class="admin-item-main"><strong>Aucune suggestion en attente</strong><p>Les suggestions envoyées depuis les fiches apparaîtront ici.</p></div></div>';
    openSug.slice(0,50).forEach(function(s){ var rr=s.di>=0?DATA[s.di]:null; html+='<div class="admin-item"><div class="admin-item-main"><strong>'+escapeHtml(rr?rr[F.NOM]:'Lieu')+'</strong><p>'+escapeHtml(s.text)+'<br><small>'+escapeHtml(s.authorName||s.author||'Utilisateur')+' · '+formatDate(s.date)+'</small></p></div><div class="admin-item-actions"><button class="small-btn primary" type="button" aria-label="Marquer la suggestion sur « '+escapeAttr(rr?rr[F.NOM]:'Lieu')+' » comme traitée" data-done-suggestion="'+s.id+'">Marquer traitée</button>'+(s.di>=0?'<button class="small-btn" type="button" aria-label="Modifier la fiche « '+escapeAttr(rr?rr[F.NOM]:'Lieu')+' »" data-edit-from-suggestion="'+s.di+'">Modifier la fiche</button>':'')+'</div></div>'; });
    html+='</div>';
    html+='<h3>Qualifications prestataires</h3><div class="admin-list" id="provSubList"><div class="admin-item"><div class="admin-item-main"><p>Chargement…</p></div></div></div>';
    html+='<h3>Catégories d’activités</h3><div class="admin-item"><div class="admin-item-main"><strong>Ajouter une activité</strong><p>Une nouvelle catégorie sera disponible dans les filtres et dans les formulaires de contribution.</p><form id="newActivityForm" class="inline-form" style="margin-top:9px"><div class="field"><label for="newActivityName">Nom de l’activité</label><input id="newActivityName" name="name" required maxlength=80 placeholder="Ex. Escape game accessible"></div><button class="small-btn primary" type="submit">Ajouter l’activité</button><div class="auth-note" id="newActivityStatus"></div></form></div></div>';
    html+='<h3>Nouveaux contenus importés</h3><p class="admin-review-intro">Aucun nouveau lieu, activité ou itinéraire n’est publié automatiquement. Les enrichissements de fiches déjà publiques sont automatiques. Cette file montre les candidats, leurs sources et les motifs de blocage. Une accessibilité absente reste explicitement inconnue.</p><div id="importReviewPanel" class="import-review-panel"><p class="admin-review-muted">Chargement de la file de revue…</p></div>';
    html+='</div></div>';
    box.innerHTML=html;
    loadProvSubs(box);
    loadImportReview(box);
    var activityForm=box.querySelector('#newActivityForm');
    if(activityForm) activityForm.addEventListener('submit',async function(e){
      e.preventDefault();
      var name=(new FormData(activityForm).get('name')||'').toString().trim();
      if(!name) return;
      if(ACTIVITES.some(function(a){return normalize(a)===normalize(name);})) { var st=box.querySelector('#newActivityStatus'); if(st) st.textContent='Cette activité existe déjà.'; return; }
      var ra=await supabaseClient.from('hilia_activities').insert({name:name});
      if(ra.error){ var st2=box.querySelector('#newActivityStatus'); if(st2) st2.textContent='Impossible d’ajouter l’activité : '+ra.error.message; return; }
      await loadRemoteContent(); location.reload();
    });
    box.querySelectorAll('[data-approve-place]').forEach(function(btn){ btn.addEventListener('click',async function(){
      var id=btn.dataset.approvePlace; btn.disabled=true;
      var r=await supabaseClient.from('hilia_places').update({status:'approved',approved_at:new Date().toISOString(),author:null}).eq('id',id);
      if(r.error){ console.error('Validation impossible',r.error); announce('Impossible de valider ce lieu : '+r.error.message,0); btn.disabled=false; return; }
      await loadRemoteContent(); location.reload();
    }); });
    box.querySelectorAll('[data-reject-place]').forEach(function(btn){ btn.addEventListener('click',async function(){
      var id=btn.dataset.rejectPlace; btn.disabled=true;
      var r=await supabaseClient.from('hilia_places').update({status:'rejected'}).eq('id',id);
      if(r.error){ console.error('Refus impossible',r.error); announce('Impossible de refuser ce lieu : '+r.error.message,0); btn.disabled=false; return; }
      await loadRemoteContent(); renderAdminArea();
    }); });
    box.querySelectorAll('[data-done-suggestion]').forEach(function(btn){ btn.addEventListener('click',async function(){
      var id=btn.dataset.doneSuggestion; btn.disabled=true;
      var result=await supabaseClient.from('hilia_suggestions').update({status:'done'}).eq('id',id);
      if(result.error){ console.error('Mise à jour impossible',result.error); announce('Impossible de modifier le statut : '+result.error.message,0); btn.disabled=false; return; }
      await loadRemoteSuggestions(); renderAdminArea();
    }); });
    box.querySelectorAll('[data-edit-from-suggestion]').forEach(function(btn){ btn.addEventListener('click',function(){ navigatePage('explore'); setListTab(); openDetail(parseInt(btn.dataset.editFromSuggestion,10)); }); });
  }
  // ---------- Revue des nouveaux contenus (administration) ----------
  var importReviewState={data:null, kind:'', level:'', selected:Object.create(null)};
  function reviewKindLabel(kind){ return kind==='place'?'Lieu':kind==='activity'?'Activité':kind==='route'?'Itinéraire':kind; }
  function reviewLevelLabel(level){ return level==='batch'?'Lot rapide':'Revue individuelle'; }
  function reviewSourceLabel(sources){
    if(!Array.isArray(sources) || !sources.length) return 'Source absente';
    return sources.map(function(s){ return s.label || s.source || 'Source'; }).join(', ');
  }
  function reviewReasonsHtml(reasons){
    if(!Array.isArray(reasons) || !reasons.length) return '<span class="admin-review-ok">Aucun blocage automatique</span>';
    return reasons.map(function(r){ return '<span class="admin-review-reason">'+escapeHtml(r.label||r.code||'À vérifier')+'</span>'; }).join(' ');
  }
  function renderImportReview(panel, payload){
    var items=payload.items||[], counts=payload.counts||{};
    var html='<div class="admin-review-toolbar"><div class="field"><label for="reviewKind">Type</label><select id="reviewKind"><option value="">Tous</option><option value="place"'+(importReviewState.kind==='place'?' selected':'')+'>Lieux</option><option value="activity"'+(importReviewState.kind==='activity'?' selected':'')+'>Activités</option><option value="route"'+(importReviewState.kind==='route'?' selected':'')+'>Itinéraires</option></select></div><div class="field"><label for="reviewLevel">Niveau</label><select id="reviewLevel"><option value="">Tous</option><option value="batch"'+(importReviewState.level==='batch'?' selected':'')+'>Lot rapide</option><option value="manual"'+(importReviewState.level==='manual'?' selected':'')+'>Revue individuelle</option></select></div><button class="small-btn" type="button" id="reviewReload">Actualiser</button></div>';
    html+='<p class="admin-review-summary"><strong>'+Number(payload.total||0).toLocaleString('fr-FR')+'</strong> candidat(s) · '+(counts.place||0)+' lieu(x) · '+(counts.activity||0)+' activité(s) · '+(counts.route||0)+' itinéraire(s)</p>';
    html+='<p class="admin-review-note">Les lieux approuvés créent une fiche <code>hilia_places</code> et y transfèrent l’enrichissement préparé ; une accessibilité absente reste explicitement inconnue. Ils ne sont visibles qu’après <code>npm run data</code>. Les activités et itinéraires approuvés restent uniquement validés en staging (<code>publication_surface = staging_only</code>), sans fiche publique.</p>';
    if(!items.length){
      html+='<div class="admin-item"><div class="admin-item-main"><strong>Aucun candidat dans ce filtre</strong><p>La file est vide ou la migration 20261114 n’a pas encore été appliquée.</p></div></div>';
    } else {
      html+='<div class="admin-review-list">';
      items.forEach(function(item){
        var checked=importReviewState.selected[item.id]?' checked':'';
        var reasons=reviewReasonsHtml(item.review_reasons);
        var sourceId=item.source_id?'<span class="admin-review-source-id">'+escapeHtml(item.source_id)+'</span>':'';
        var location=[item.commune,item.postal_code].filter(Boolean).join(' · ');
        html+='<article class="admin-review-item"><label class="admin-review-check"><input type="checkbox" data-review-id="'+escapeAttr(item.id)+'"'+checked+'><span class="sr-only">Sélectionner '+escapeHtml(item.name||item.id)+'</span></label><div class="admin-review-main"><div class="admin-review-title"><strong>'+escapeHtml(item.name||'Sans nom')+'</strong><span class="admin-review-kind">'+escapeHtml(reviewKindLabel(item.kind))+'</span><span class="admin-review-level '+(item.review_level==='batch'?'batch':'manual')+'">'+escapeHtml(reviewLevelLabel(item.review_level))+'</span></div><p class="admin-review-meta">'+escapeHtml(reviewSourceLabel(item.sources))+(location?' · '+escapeHtml(location):'')+(item.published_place_id?' · publié : '+escapeHtml(item.published_place_id):'')+'</p><p class="admin-review-reasons">'+reasons+'</p><p class="admin-review-source">'+sourceId+'</p></div></article>';
      });
      html+='</div>';
    }
    html+='<div class="admin-review-actions"><label class="admin-review-check"><input type="checkbox" id="reviewSelectAll"> <span>Tout sélectionner sur cette page</span></label><button class="small-btn primary" type="button" data-review-decision="approve">Approuver la sélection</button><button class="small-btn" type="button" data-review-decision="needs_review">Laisser à revoir</button><button class="small-btn danger" type="button" data-review-decision="reject">Rejeter la sélection</button></div>';
    panel.innerHTML=html;
    var kind=panel.querySelector('#reviewKind'), level=panel.querySelector('#reviewLevel');
    if(kind) kind.addEventListener('change',function(){ importReviewState.kind=kind.value; importReviewState.selected=Object.create(null); loadImportReview(panel); });
    if(level) level.addEventListener('change',function(){ importReviewState.level=level.value; importReviewState.selected=Object.create(null); loadImportReview(panel); });
    var reload=panel.querySelector('#reviewReload'); if(reload) reload.addEventListener('click',function(){ loadImportReview(panel); });
    panel.querySelectorAll('[data-review-id]').forEach(function(cb){ cb.addEventListener('change',function(){ if(cb.checked) importReviewState.selected[cb.dataset.reviewId]=true; else delete importReviewState.selected[cb.dataset.reviewId]; }); });
    var all=panel.querySelector('#reviewSelectAll'); if(all) all.addEventListener('change',function(){ panel.querySelectorAll('[data-review-id]').forEach(function(cb){ cb.checked=all.checked; if(all.checked) importReviewState.selected[cb.dataset.reviewId]=true; else delete importReviewState.selected[cb.dataset.reviewId]; }); });
    panel.querySelectorAll('[data-review-decision]').forEach(function(btn){ btn.addEventListener('click',function(){ decideImportReview(panel,btn.dataset.reviewDecision,btn); }); });
  }
  async function loadImportReview(box){
    var panel=box && (box.id==='importReviewPanel' ? box : box.querySelector('#importReviewPanel')); if(!panel) return;
    if(!supabaseClient){ panel.innerHTML='<p class="admin-review-muted">Connectez-vous avec un compte administrateur pour voir la file.</p>'; return; }
    panel.innerHTML='<p class="admin-review-muted">Chargement de la file de revue…</p>';
    try{
      var result=await supabaseClient.rpc('hilia_admin_review_queue',{p_kind:importReviewState.kind||null,p_level:importReviewState.level||null,p_limit:30,p_offset:0});
      if(result.error) throw result.error;
      importReviewState.data=result.data||{total:0,counts:{},items:[]};
      renderImportReview(panel,importReviewState.data);
    }catch(err){
      panel.innerHTML='<p class="admin-review-error">File de revue indisponible : '+escapeHtml(err && err.message || 'erreur inconnue')+'</p><p class="admin-review-muted">Vérifiez que la migration <code>20261114_hilia_review.sql</code> est appliquée et que votre compte a le rôle admin.</p>';
    }
  }
  async function decideImportReview(panel,decision,button){
    var ids=Object.keys(importReviewState.selected);
    if(!ids.length){ announce('Sélectionnez au moins un candidat.',300); return; }
    if(decision==='reject' && !confirm('Rejeter '+ids.length+' candidat(s) ?')) return;
    button.disabled=true;
    try{
      var result=await supabaseClient.rpc('hilia_admin_review_decision',{p_ids:ids,p_decision:decision,p_note:null});
      if(result.error) throw result.error;
      importReviewState.selected=Object.create(null);
      var msg=result.data && result.data.note_published ? result.data.note_published : 'Décision enregistrée.';
      announce(msg,5000);
      await loadImportReview(panel.closest('#profileAdminArea')||panel.parentElement);
    }catch(err){
      announce('Décision impossible : '+(err && err.message || 'erreur inconnue'),6000);
    }finally{ button.disabled=false; }
  }

  document.getElementById('prototypeRoleSelect').addEventListener('change',function(){ this.value='user'; if(profileState){profileState.role='user'; localStorage.setItem(PROFILE_KEY,JSON.stringify(profileState)); renderProfilePage();} });
  async function saveReview(di, rating, comment){
    var p=getProfile(); if(!p || !supabaseClient || !p.id) return false;
    var ref=placeRef(di); if(!ref){ announce('Cette fiche n’a pas pu être identifiée. Rechargez la page puis réessayez.',0); return false; }
    var payload={place_id:ref,user_id:p.id,author_name:p.name||p.email.split('@')[0],rating:Number(rating),comment:comment.trim()};
    var result=await supabaseClient.from('hilia_reviews').upsert(payload,{onConflict:'place_id,user_id'});
    if(result.error){ console.error('Publication de l’avis impossible',result.error); announce('Impossible de publier l’avis : '+result.error.message,0); return false; }
    invalidateReviews(ref); await fetchReviews([ref]); syncRatingFromLoaded(di); return true;
  }
  async function removeReview(di,email,date){
    var p=getProfile(); if(!p || !supabaseClient || !p.id) return false;
    var ref=placeRef(di), list=reviewsFor(di);
    var target=list.find(function(r){return r.date===date && r.user_id===p.id;});
    if(!target) return false;
    var result=await supabaseClient.from('hilia_reviews').delete().eq('id',target.id);
    if(result.error){ console.error('Suppression de l’avis impossible',result.error); announce('Impossible de supprimer cet avis.',0); return false; }
    invalidateReviews(ref); await fetchReviews([ref]); syncRatingFromLoaded(di); return true;
  }
  async function saveSuggestion(di,textValue){
    var p=getProfile(); if(!p || !supabaseClient || !textValue.trim()) return false;
    var ref=placeRef(di); if(!ref){ announce('Cette fiche n’a pas pu être identifiée. Rechargez la page puis réessayez.',0); return false; }
    var payload={id:'suggestion_'+Date.now()+'_'+Math.random().toString(16).slice(2),place_id:ref,suggestion_text:textValue.trim().slice(0,1200),author_email:p.email,author_name:p.name||String(p.email||'').split('@')[0],status:'open'};
    var result=await supabaseClient.from('hilia_suggestions').insert(payload);
    if(result.error){ console.error('Envoi de la suggestion impossible',result.error); announce('Impossible d’envoyer la suggestion : '+result.error.message,0); return false; }
    if(roleOf(p)==='admin') await loadRemoteSuggestions();
    return true;
  }
  function formatDate(v){ try{ return new Date(v).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric'}); }catch(e){ return ''; } }
  function reviewsHtml(di){
    var list=reviewListFor(di), p=getProfile(), html='<div class="review-block"><div class="review-head"><h3 id="reviewsHeading" tabindex="-1">Avis</h3><div class="review-score">'+reviewSummaryHtml(di,'full')+'</div></div>';
    if(list.length){ html+='<div class="review-list">'; list.forEach(function(rv){ html+='<article class="review-item"><div class="review-item-top"><strong>'+escapeHtml(rv.name||'Utilisateur')+'</strong><span class="review-date">'+formatDate(rv.date)+'</span></div><div>'+starsHtml(rv.rating)+'</div><div class="review-comment">'+escapeHtml(rv.comment||'')+'</div>'; if(p && roleOf(p)==='admin') html+='<div style="margin-top:8px"><button type="button" class="small-btn danger" aria-label="Retirer l’avis de '+escapeAttr(rv.name||'Utilisateur')+'" data-delete-review="'+di+'" data-review-email="'+escapeAttr(rv.email)+'" data-review-date="'+escapeAttr(rv.date)+'">Retirer cet avis</button></div>'; html+='</article>'; }); html+='</div>'; }
    if(p){ html+='<form class="review-form" data-review-form="'+di+'"><div class="review-form-grid"><div class="field" style="margin:0"><label for="reviewRating'+di+'">Note</label><select id="reviewRating'+di+'" name="rating" required><option value="5">5/5</option><option value="4">4/5</option><option value="3">3/5</option><option value="2">2/5</option><option value="1">1/5</option></select></div><div class="field" style="margin:0"><label for="reviewComment'+di+'">Votre avis</label><textarea id="reviewComment'+di+'" name="comment" maxlength="1200" required placeholder="Décrivez votre expérience, l’accueil ou les conditions d’accès…"></textarea></div></div><button class="primary-btn" type="submit" style="margin-top:10px">Publier mon avis</button><p class="auth-note" style="margin-bottom:0">Un avis par compte et par lieu. Vous pouvez le mettre à jour en publiant un nouvel avis.</p></form>'; html+='<div class="detail-contrib-actions"><button class="detail-action-btn" type="button" data-open-suggestion="'+di+'">Suggérer une modification</button>'; if(roleOf(p)==='admin') html+='<button class="detail-action-btn primary" type="button" data-open-edit="'+di+'">Modifier les informations</button>'; html+='</div><div id="detailSuggestionForm"></div><div id="detailEditForm"></div>'; }
    else { html+='<div class="review-login-prompt"><p>Connectez-vous pour laisser un avis, suggérer une correction ou contribuer à une fiche.</p><button class="secondary-btn" type="button" data-review-login="1">Se connecter</button></div>'; }
    return html+'</div>';
  }
  function bindReviewActions(di){
    var form=detailContent.querySelector('[data-review-form="'+di+'"]'); if(form) form.addEventListener('submit',async function(e){ e.preventDefault(); var rating=form.querySelector('[name="rating"]').value, comment=form.querySelector('[name="comment"]').value; if(comment.trim().length<3){ announce('Votre avis est trop court : 3 caractères minimum.',0); form.querySelector('[name="comment"]').setAttribute('aria-invalid','true'); form.querySelector('[name="comment"]').focus(); return; } var btn=form.querySelector('[type="submit"]'); btn.disabled=true; try{ if(await saveReview(di,rating,comment)){ openDetail(di,true); renderProfilePage(); refreshReviewMinis(); announce('Votre avis a été publié.',150); } }finally{btn.disabled=false;} });
    detailContent.querySelectorAll('[data-delete-review]').forEach(function(btn){ btn.addEventListener('click',async function(){ btn.disabled=true; try{ if(await removeReview(parseInt(btn.dataset.deleteReview,10),btn.dataset.reviewEmail,btn.dataset.reviewDate)){ openDetail(di,true); renderProfilePage(); refreshReviewMinis(); announce('Avis retiré.',150); } }finally{btn.disabled=false;} }); });
    var loginBtn=detailContent.querySelector('[data-review-login]'); if(loginBtn) loginBtn.addEventListener('click',function(){ closeDetail(); navigatePage('profile'); });
    var suggestBtn=detailContent.querySelector('[data-open-suggestion]'); if(suggestBtn) suggestBtn.addEventListener('click',function(){
      var holder=document.getElementById('detailSuggestionForm'); if(!holder) return; holder.innerHTML='<form class="inline-form"><div class="field" style="margin-bottom:9px"><label for="suggestionText'+di+'">Votre suggestion</label><textarea id="suggestionText'+di+'" name="text" required maxlength="1200" placeholder="Ex. L’adresse est incorrecte, une rampe a été ajoutée, les sanitaires ne sont plus accessibles…"></textarea></div><button class="small-btn primary" type="submit">Envoyer la suggestion</button><span class="auth-note" style="margin-left:8px">Elle sera revue par un Admin.</span></form>'; var f=holder.querySelector('form'); f.addEventListener('submit',async function(e){e.preventDefault();var v=f.querySelector('textarea').value;if(await saveSuggestion(di,v)){holder.innerHTML='<div class="auth-note" role="status">Merci ! Votre suggestion a été transmise à la modération.</div>';announce('Votre suggestion a bien été envoyée à la modération.');renderAdminArea();}});
    });
    var editBtn=detailContent.querySelector('[data-open-edit]'); if(editBtn) editBtn.addEventListener('click',function(){
      var r=DATA[di], holder=document.getElementById('detailEditForm'); if(!holder) return;
      holder.innerHTML='<form class="inline-form edit-form"><div class="inline-form-grid"><div class="field"><label for="editName'+di+'">Nom</label><input id="editName'+di+'" name="name" required value="'+escapeAttr(r[F.NOM])+'"></div><div class="field"><label for="editActivity'+di+'">Activité</label><select id="editActivity'+di+'" name="activity">'+ACTIVITES.map(function(a){return '<option '+(a===ACTIVITES[r[F.ACT]]?'selected':'')+'>'+escapeHtml(a)+'</option>';}).join('')+'</select></div><div class="field"><label for="editAddress'+di+'">Adresse</label><input id="editAddress'+di+'" name="address" value="'+escapeAttr(r[F.ADR])+'"></div><div class="field"><label for="editCp'+di+'">Code postal</label><input id="editCp'+di+'" name="cp" value="'+escapeAttr(r[F.CP])+'"></div><div class="field"><label for="editCommune'+di+'">Commune</label><input id="editCommune'+di+'" name="commune" list="communesList" value="'+escapeAttr(COMMUNES[r[F.COM]])+'"></div><div class="field"><label for="editSite'+di+'">Site internet</label><input id="editSite'+di+'" name="site" value="'+escapeAttr(r[F.SITE]||'')+'"></div>'+accessFormHtml('edit'+di,r)+'</div><button class="small-btn primary" type="submit">Enregistrer les modifications</button></form>';
      var ef=holder.querySelector('form'); ef.addEventListener('submit',async function(e){e.preventDefault();var fd=new FormData(ef);
        var row={place_id:String(di),name:fd.get('name').trim(),address:fd.get('address').trim(),cp:fd.get('cp').trim(),commune:fd.get('commune').trim(),activity:fd.get('activity'),site:safeExternalUrl(fd.get('site')),access:readAccess(fd),updated_at:new Date().toISOString()};
        var r=await supabaseClient.from('hilia_place_edits').upsert(row,{onConflict:'place_id'});
        if(r.error){ console.error('Modification impossible',r.error); announce('Impossible d’enregistrer la modification : '+r.error.message,0); return; }
        await loadRemoteContent(); announce('Les modifications ont bien été enregistrées.'); location.reload();});
    });
  }
  function refreshReviewMinis(){ document.querySelectorAll('[data-review-mini-index]').forEach(function(el){ el.innerHTML=reviewSummaryHtml(parseInt(el.dataset.reviewMiniIndex,10),'mini'); }); }


  // ---------- Description audio d'un lieu (synthèse vocale du navigateur) ----------
  // Le texte est généré à partir des champs de la fiche : aucun enregistrement à faire par lieu.
  // Pour passer plus tard à une voix neuronale (API), remplacer uniquement la lecture (speakFrom).
  function buildAudioText(r){
    var parts=[];
    var activite=ACTIVITES[r[F.ACT]]||'';
    var commune=COMMUNES[r[F.COM]]||'';
    parts.push(r[F.NOM]+'.');
    if(activite) parts.push('Type de lieu : '+activite+'.');
    if(r[F.ADR]||commune) parts.push('Adresse : '+[r[F.ADR],[r[F.CP],commune].filter(Boolean).join(' ')].filter(Boolean).join(', ')+'.');
    var SECTIONS=[
      ['Stationnement et abords',[
        [F.TRANSPORT,'Un transport en commun est signalé à proximité.','Aucun transport en commun n’est signalé à proximité.','transport en commun'],
        [F.STATIONNEMENT,'Un stationnement est disponible.','Il n’y a pas de stationnement disponible.','stationnement'],
        [F.STATIONNEMENT_PMR,'Des places de stationnement PMR sont prévues.','Il n’y a pas de place de stationnement PMR.','places PMR'],
        [F.STATIONNEMENT_EXT,'Un stationnement extérieur est disponible.','Il n’y a pas de stationnement extérieur.','stationnement extérieur'],
        [F.STATIONNEMENT_EXT_PMR,'Des places PMR existent sur le stationnement extérieur.','Il n’y a pas de place PMR sur le stationnement extérieur.','places PMR extérieures']
      ]],
      ['Cheminement extérieur',[
        [F.CHEMIN_PLAIN_PIED,'Le cheminement extérieur est de plain-pied.','Le cheminement extérieur n’est pas de plain-pied.','plain-pied'],
        [F.CHEMIN_TERRAIN_STABLE,'Le terrain est stable.','Le terrain n’est pas stable.','terrain stable'],
        [F.CHEMIN_REPERAGE,'Les marches sont repérables.','Les marches ne sont pas repérées.','repérage des marches'],
        [F.CHEMIN_MAIN_COURANTE,'Une main courante est présente.','Il n’y a pas de main courante.','main courante'],
        [F.CHEMIN_RAMPE,'Une rampe d’accès est présente.','Il n’y a pas de rampe d’accès.','rampe d’accès'],
        [F.CHEMIN_BANDE_GUIDAGE,'Une bande de guidage est présente pour les personnes malvoyantes.','Il n’y a pas de bande de guidage.','bande de guidage']
      ]],
      ['Entrée',[
        [F.ENTREE_REPERABLE,'L’entrée est facilement repérable.','L’entrée n’est pas facilement repérable.','entrée repérable'],
        [F.ENTREE_PLAIN_PIED,'L’entrée est de plain-pied.','L’entrée n’est pas de plain-pied.','entrée de plain-pied'],
        [F.ENTREE_ASCENSEUR,'Un ascenseur est disponible.','Il n’y a pas d’ascenseur.','ascenseur'],
        [F.ENTREE_RAMPE,'Une rampe d’accès est présente à l’entrée.','Il n’y a pas de rampe d’accès à l’entrée.','rampe à l’entrée'],
        [F.ENTREE_DISPOSITIF_APPEL,'Un dispositif d’appel est présent.','Il n’y a pas de dispositif d’appel.','dispositif d’appel'],
        [F.ENTREE_BALISE_SONORE,'Une balise sonore guide vers l’entrée.','Il n’y a pas de balise sonore.','balise sonore'],
        [F.ENTREE_AIDE_HUMAINE,'Une aide humaine est possible sur demande.','Aucune aide humaine n’est signalée.','aide humaine'],
        [F.ENTREE_SPECIFIQUE_PMR,'Une entrée spécifique PMR existe.','Il n’y a pas d’entrée spécifique PMR.','entrée PMR']
      ],function(){
        var x=[];
        var m=r[F.ENTREE_MARCHES];
        if(m!=null && m!==''){ var n=Number(m); x.push(n===0?'Il n’y a aucune marche à l’entrée.':('Il y a '+n+(n>1?' marches':' marche')+' à l’entrée.')); }
        if(r[F.ENTREE_LARGEUR]) x.push('La largeur minimale de l’entrée est de '+r[F.ENTREE_LARGEUR]+' centimètres.');
        return x;
      }],
      ['Accueil',[
        [F.ACCUEIL_PERSONNEL,'Du personnel est présent à l’accueil.','Il n’y a pas de personnel à l’accueil.','personnel à l’accueil'],
        [F.ACCUEIL_AUDIODESCR,'Une audiodescription est proposée par le lieu.','Le lieu ne propose pas d’audiodescription.','audiodescription proposée par le lieu'],
        [F.ACCUEIL_EQUIP_MALENT,'Des équipements pour les personnes malentendantes sont disponibles.','Il n’y a pas d’équipement pour les personnes malentendantes.','équipements pour malentendants'],
        [F.ACCUEIL_PLAIN_PIED,'Le cheminement jusqu’à l’accueil est de plain-pied.','Le cheminement jusqu’à l’accueil n’est pas de plain-pied.','accueil de plain-pied'],
        [F.ACCUEIL_SIGNALETIQUE,'La signalétique intérieure est adaptée.','La signalétique intérieure n’est pas adaptée.','signalétique intérieure']
      ]],
      ['Sanitaires',[
        [F.SANITAIRES_DISPO,'Des sanitaires sont disponibles pour le public.','Il n’y a pas de sanitaires pour le public.','sanitaires'],
        [F.SANITAIRES_PMR,'Des sanitaires adaptés PMR sont disponibles.','Il n’y a pas de sanitaires adaptés PMR.','sanitaires adaptés PMR']
      ]]
    ];
    SECTIONS.forEach(function(sec){
      var out=[];
      sec[1].forEach(function(it){
        var v=r[it[0]];
        if(isTrue(v)) out.push(it[1]);
        else if(isFalse(v)) out.push(it[2]);
        // Valeur inconnue : omise du résumé vocal, sans supposer oui ou non.
      });
      if(sec[2]) out=out.concat(sec[2]());
      if(out.length) parts.push(sec[0]+'. '+out.join(' '));
    });
    var labels=publicLabels(parseListField(r[F.LABELS]));
    var familles=parseListField(r[F.FAMILLES]).map(function(f){ return FAMILLE_LABELS[f]||''; }).filter(Boolean);
    var all=labels.concat(familles);
    if(all.length) parts.push('Labels et reconnaissance : '+all.join(', ')+'.');
    if(r[F.CONFORMITE]!=null) parts.push('Conformité réglementaire déclarée par l’établissement : '+(isTrue(r[F.CONFORMITE])?'oui':'non')+'.');
    parts.push('Ces informations sont déclarées et peuvent être incomplètes. Pensez à les vérifier auprès du lieu avant de vous déplacer.');
    return parts;
  }

  var AudioDesc = (function(){
    var supported = ('speechSynthesis' in window) && ('SpeechSynthesisUtterance' in window);
    var chunks=[], idx=0, status='idle', token=0, ui=null;
    function frVoice(){
      var vs=(window.speechSynthesis.getVoices&&window.speechSynthesis.getVoices())||[];
      var fr=vs.filter(function(v){ return /^fr([-_]|$)/i.test(v.lang); });
      return fr.find(function(v){ return /^fr[-_]FR/i.test(v.lang) && v.localService; }) || fr.find(function(v){ return /^fr[-_]FR/i.test(v.lang); }) || fr[0] || null;
    }
    function render(){
      if(!ui) return;
      var label = status==='playing' ? 'Mettre en pause la description' : (status==='paused' ? 'Reprendre la description' : 'Écouter la description du lieu');
      ui.label.textContent = label;
      ui.play.setAttribute('aria-label', label);
      ui.stop.hidden = (status==='idle');
    }
    function speakFrom(i){
      var my=++token; window.speechSynthesis.cancel(); idx=i;
      (function next(){
        if(my!==token) return;
        if(idx>=chunks.length){ status='idle'; idx=0; render(); announce('Description terminée.',200); return; }
        var u=new SpeechSynthesisUtterance(chunks[idx]);
        u.lang='fr-FR'; u.rate=0.95;
        var v=frVoice(); if(v) u.voice=v;
        u.onend=function(){ if(my!==token) return; idx++; next(); };
        u.onerror=function(e){ if(my!==token) return; if(e && (e.error==='canceled'||e.error==='interrupted')) return; status='idle'; render(); announce('La lecture audio a échoué.',200); };
        window.speechSynthesis.speak(u);
      })();
    }
    function stop(silent){
      if(!supported) return;
      token++; window.speechSynthesis.cancel();
      var was=status; status='idle'; idx=0; chunks=[]; render();
      if(!silent && was!=='idle') announce('Lecture arrêtée.',100);
    }
    return {
      supported:supported,
      bind:function(di){
        stop(true);
        ui=null;
        var root=detailContent.querySelector('#audioDesc'); if(!root) return;
        if(!supported){
          root.innerHTML='<p class="audio-note">La lecture audio n’est pas disponible sur ce navigateur. Les informations de la fiche ci-dessous restent lisibles avec un lecteur d’écran.</p>';
          return;
        }
        ui={ play:root.querySelector('#audioPlayBtn'), stop:root.querySelector('#audioStopBtn'), label:root.querySelector('#audioPlayLabel') };
        ui.play.addEventListener('click',function(){
          if(status==='idle'){ chunks=buildAudioText(DATA[di]); status='playing'; render(); speakFrom(0); }
          else if(status==='playing'){ token++; window.speechSynthesis.cancel(); status='paused'; render(); announce('Lecture en pause.',100); }
          else { status='playing'; render(); speakFrom(idx); }
        });
        ui.stop.addEventListener('click',function(){ stop(false); ui.play.focus(); });
        render();
      },
      stop:stop
    };
  })();
  window.addEventListener('pagehide',function(){ AudioDesc.stop(true); });

  function makePlaceSlug(r){
    var base=String(r[F.NOM]||'lieu').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
    // L'identifiant Supabase rend le lien de la fiche unique et stable.
    var id=r._hiliaPlaceId!=null?String(r._hiliaPlaceId):String(r[F.CP]||'')+'-'+String(r[F.COM]!=null?COMMUNES[r[F.COM]]:'');
    id=id.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
    return (base||'lieu')+'-'+(id||'fiche');
  }
  function openPlaceFromSlug(slug){
    var idx=DATA.findIndex(function(r){return makePlaceSlug(r)===slug;});
    if(idx>=0){ navigatePage('explore',false); setListTab(); openDetail(idx,true); return true; }
    return false;
  }
  // ---------- Détails enrichis, chargés à la demande ----------
  // Le catalogue de base reste léger. Les descriptions, photos, horaires et
  // tarifs vivent dans des shards séparés : une fiche ne télécharge que le sien.
  var detailLoadToken = 0;
  var placeDetailCache = Object.create(null);
  var placeDetailPromises = Object.create(null);
  var placeDetailRemotePromises = Object.create(null);
  function detailBucket(id, count){
    var hash = 2166136261;
    String(id).split('').forEach(function(ch){ hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); });
    return (hash >>> 0) % count;
  }
  function detailShard(id, count){ return String(detailBucket(id, count)).padStart(3, '0'); }
  function mediaProxyUrl(url){ return '/api/media?u=' + encodeURIComponent(url); }
  function paragraphsHtml(text){
    return String(text || '').split(/\n{2,}/).map(function(block){
      return '<p>' + escapeHtml(block).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function formatPriceItem(item){
    var cur = item.currency ? ' ' + item.currency : '';
    if (item.price != null) return item.price + cur;
    if (item.min != null && item.max != null && item.min !== item.max) return item.min + '–' + item.max + cur;
    if (item.min != null) return item.min + cur;
    if (item.max != null) return item.max + cur;
    return '';
  }
  function mediaGalleryHtml(media, title, fallbackKey){
    if(!media || !media.length) return '';
    var html='<div class="d-section d-gallery-section"><h3>Photos</h3><div class="d-gallery">';
    media.forEach(function(m, i){
      html += '<figure class="media-card' + (i === 0 ? ' media-main' : '') + '" data-fallback-key="' + escapeAttr(fallbackKey || 'general') + '"><img data-media-img src="' + escapeAttr(mediaProxyUrl(m.url)) + '" alt="' + escapeAttr(title + ' (photo ' + (i + 1) + ')') + '" loading="lazy" decoding="async"><figcaption><span>' + escapeHtml(m.credit || 'Crédit non précisé') + '</span>';
      if(m.source) html += ' · ' + escapeHtml(m.source);
      if(m.licence) html += ' · ' + escapeHtml(m.licence);
      html += '</figcaption></figure>';
    });
    return html + '</div><p class="media-credit-note">Crédit et source conservés sous chaque image. Si une photo ne répond pas, une illustration de catégorie la remplace clairement, sans jamais la présenter comme une photo du lieu.</p></div>';
  }
  function bindMediaFallbacks(container){
    container.querySelectorAll('[data-media-img]').forEach(function(img){
      img.addEventListener('error', function(){
        var fig=img.closest('figure'); if(!fig) return;
        var key=fig.getAttribute('data-fallback-key') || 'general';
        fig.classList.add('is-unavailable');
        fig.innerHTML=illustrationSVG(key)+'<figcaption><span>Image indisponible · illustration HILIA</span></figcaption>';
      });
    });
  }
  function placeSourceLine(src){
    if(!src) return '';
    var label = src.label || 'Source';
    var html = 'Source : ' + escapeHtml(label);
    if(src.licenceLabel) html += ' · ' + escapeHtml(src.licenceLabel);
    if(src.updatedAt) html += ' · mise à jour ' + escapeHtml(String(src.updatedAt).slice(0, 10));
    if(src.url) html += ' · <a href="' + escapeAttr(safeExternalUrl(src.url)) + '" target="_blank" rel="noopener noreferrer">voir la source<span class="sr-only"> (nouvelle fenêtre)</span></a>';
    return '<p class="d-source-line">' + html + '</p>';
  }
  function descriptionBlocks(text){
    return String(text || '').split(/\n{2,}/).map(function(block){ return block.trim(); }).filter(Boolean);
  }
  function descriptionSnippet(text){
    var blocks=descriptionBlocks(text);
    var full=paragraphsHtml(text);
    if(!blocks.length) return {short:'', full:'', expandable:false};
    var shortBlocks=[], length=0;
    for(var i=0; i<blocks.length; i++){
      if(shortBlocks.length && length + blocks[i].length > 460) break;
      shortBlocks.push(blocks[i]); length += blocks[i].length;
      if(length > 460) break;
    }
    var shortText=shortBlocks.join('\n\n');
    if(shortText.length > 500) shortText=shortText.slice(0, 500).replace(/\s+\S*$/, '') + '…';
    var expandable=shortText.replace(/…$/, '') !== blocks.join('\n\n');
    return {short:paragraphsHtml(shortText), full:full, expandable:expandable};
  }
  function bindDescriptionToggle(container){
    container.querySelectorAll('[data-expand-description]').forEach(function(button){
      button.addEventListener('click', function(){
        var full=container.querySelector('[data-description-full]');
        var short=container.querySelector('[data-description-short]');
        if(!full || !short) return;
        var open=full.hasAttribute('hidden');
        if(open){ full.removeAttribute('hidden'); short.setAttribute('hidden',''); button.textContent='Réduire'; button.setAttribute('aria-expanded','true'); }
        else { full.setAttribute('hidden',''); short.removeAttribute('hidden'); button.textContent='Lire la suite'; button.setAttribute('aria-expanded','false'); }
      });
    });
  }
  function renderPlaceEnrichment(detail, row){
    var html='';
    // La première photo exploitable sert de visuel principal ; les crédits
    // restent attachés à chaque image et une indisponibilité est signalée.
    html += mediaGalleryHtml(detail.media, row[F.NOM], CATEGORY_TEMPLATE[ACTIVITES[row[F.ACT]]] || 'general');
    if(detail.description){
      var desc=descriptionSnippet(detail.description);
      html += '<div class="d-section d-description"><h3>À propos</h3><div data-description-short>' + desc.short + '</div>';
      if(desc.expandable){
        html += '<div data-description-full hidden>' + desc.full + '</div>';
        html += '<button type="button" class="d-read-more" data-expand-description aria-expanded="false">Lire la suite</button>';
      }
      html += placeSourceLine(detail.descriptionSource) + '</div>';
    }
    if(detail.hours && detail.hours.length){
      html += '<div class="d-section d-practical"><h3>Horaires</h3><ul class="d-hours">';
      detail.hours.forEach(function(h){
        if(h.text){ html += '<li>' + escapeHtml(h.text) + '</li>'; return; }
        var when = (h.days && h.days.length) ? h.days.join(', ') : 'Horaires';
        var time = h.opens || h.closes ? ' : ' + escapeHtml([h.opens, h.closes].filter(Boolean).join('–')) : '';
        var period = (h.from || h.to) ? ' <span class="d-muted">(' + escapeHtml([h.from, h.to].filter(Boolean).join(' → ')) + ')</span>' : '';
        html += '<li><strong>' + escapeHtml(when) + '</strong>' + time + period + (h.note ? ' · ' + escapeHtml(h.note) : '') + '</li>';
      });
      html += '</ul><p class="d-source-line">Horaires déclarés par la source. Vérifiez avant de vous déplacer.</p></div>';
    }
    if(detail.prices && detail.prices.items && detail.prices.items.length){
      html += '<div class="d-section d-practical"><h3>Tarifs</h3>';
      if(detail.prices.free === true) html += '<p class="d-price-summary">Gratuit selon la source.</p>';
      html += '<ul class="d-prices">';
      detail.prices.items.forEach(function(item){
        var amount = formatPriceItem(item);
        html += '<li>' + (item.label ? '<span>' + escapeHtml(item.label) + '</span>' : '<span>Tarif</span>') + (amount ? '<b>' + escapeHtml(amount) + '</b>' : '') + (item.period ? ' <span class="d-muted">' + escapeHtml(item.period) + '</span>' : '') + '</li>';
      });
      html += '</ul><p class="d-source-line">Tarifs déclarés, non garantis au moment de la visite. Aucune disponibilité ni commission n’est déduite.</p></div>';
    }
    if(detail.contacts){
      var c=detail.contacts, hasContact=(c.phones&&c.phones.length)||(c.emails&&c.emails.length)||(c.websites&&c.websites.length);
      if(hasContact){
        html += '<div class="d-section d-practical"><h3>Contact</h3><ul class="d-contacts">';
        (c.phones||[]).forEach(function(p){ html += '<li><span>Téléphone</span><a href="tel:' + escapeAttr(p) + '">' + escapeHtml(p) + '</a></li>'; });
        (c.emails||[]).forEach(function(m){ html += '<li><span>E-mail</span><a href="mailto:' + escapeAttr(m) + '">' + escapeHtml(m) + '</a></li>'; });
        (c.websites||[]).forEach(function(u){ var safe=safeExternalUrl(u); if(safe) html += '<li><span>Site</span><a href="' + escapeAttr(safe) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(u) + '<span class="sr-only"> (nouvelle fenêtre)</span></a></li>'; });
        html += '</ul><p class="d-source-line">Coordonnées issues des sources. Elles peuvent évoluer.</p></div>';
      }
    }
    if(detail.categories && detail.categories.length > 1){
      html += '<div class="d-section"><h3>Catégories détaillées</h3><div class="d-badges">';
      detail.categories.forEach(function(c){ html += '<span class="d-badge">' + escapeHtml(c.name) + '</span>'; });
      html += '</div></div>';
    }
    if(detail.accessibility && detail.accessibility.sources && detail.accessibility.sources.length){
      html += '<div class="d-section"><h3>Sources d’accessibilité</h3><p class="d-source-line">';
      html += detail.accessibility.sources.map(function(s){ return escapeHtml(s.label + (s.updatedAt ? ' (' + String(s.updatedAt).slice(0, 10) + ')' : '')); }).join(' · ');
      html += '</p><p class="d-source-line">Données déclaratives, parfois différentes selon les sources. Aucune conclusion n’est déduite d’une information absente.</p></div>';
    }
    return html;
  }
  function remotePlaceDetail(row){
    return {
      description: row.description,
      descriptionSource: row.description_source,
      categories: row.categories || [],
      media: row.media || [],
      hours: row.hours || [],
      prices: row.prices,
      contacts: row.contacts,
      accessibility: row.accessibility,
      sourceRefs: row.source_refs || [],
    };
  }
  function loadPlaceDetail(id){
    if(!id) return Promise.resolve(null);
    if(placeDetailCache[id]) return Promise.resolve(placeDetailCache[id]);
    var bucket = detailShard(id, 256);
    if(!placeDetailPromises[bucket]){
      placeDetailPromises[bucket] = fetch('/data/place-details/' + bucket + '.json', {cache:'no-cache'})
        .then(function(res){ return res.ok ? res.json() : null; })
        .then(function(ds){
          if(ds && ds.places) Object.keys(ds.places).forEach(function(k){ placeDetailCache[k]=ds.places[k]; });
          return true;
        })
        .catch(function(){ return false; });
    }
    return placeDetailPromises[bucket].then(function(){
      if(placeDetailCache[id]) return placeDetailCache[id];
      // Les nouveaux lieux approuvés n'ont pas de shard statique : leur détail
      // public est lu directement dans Supabase, sous les politiques RLS.
      if(!supabaseClient || String(id).indexOf('place_imp_')!==0) return null;
      if(!placeDetailRemotePromises[id]){
        placeDetailRemotePromises[id]=supabaseClient.from('hilia_place_details')
          .select('description,description_source,categories,media,hours,prices,contacts,accessibility,source_refs')
          .eq('place_id',String(id))
          .maybeSingle()
          .then(function(result){
            if(result.error || !result.data) return null;
            var detail=remotePlaceDetail(result.data);
            placeDetailCache[id]=detail;
            return detail;
          })
          .catch(function(){ return null; });
      }
      return placeDetailRemotePromises[id];
    });
  }
  function hydratePlaceDetail(di, row, token){
    var holder=document.getElementById('detailEnrichment');
    if(!holder || !row._hiliaPlaceId) return;
    loadPlaceDetail(String(row._hiliaPlaceId)).then(function(detail){
      if(token !== detailLoadToken) return;
      if(!detail){ holder.remove(); return; }
      holder.removeAttribute('aria-busy');
      holder.innerHTML = renderPlaceEnrichment(detail, row);
      bindMediaFallbacks(holder);
      bindDescriptionToggle(holder);
    });
  }

  function openDetail(di, keepOpen){
    detailLoadToken += 1;
    var detailToken = detailLoadToken;
    AudioDesc.stop(true);
    var trigger = document.activeElement;
    closeDrawer();
    if(leafletMap) leafletMap.closePopup();
    var r = DATA[di];
    var color = colorFor(r[F.ACT]);
    var idx = accessIndex[di];
    var known = completenessKnown[di];
    var html='';
    html += '<h2 id="detailDialogTitle">'+escapeHtml(r[F.NOM])+'</h2>';
    html += '<div class="d-addr">'+escapeHtml(r[F.ADR])+', '+r[F.CP]+' '+escapeHtml(COMMUNES[r[F.COM]])+'</div>';
    html += '<div class="audio-desc" id="audioDesc" role="group" aria-label="Description audio du lieu"><div class="audio-desc-actions">'
      + '<button type="button" class="primary-btn audio-btn" id="audioPlayBtn" aria-label="Écouter la description du lieu"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg><span id="audioPlayLabel" aria-hidden="true">Écouter la description du lieu</span></button>'
      + '<button type="button" class="secondary-btn audio-btn" id="audioStopBtn" hidden>Arrêter la lecture</button></div>'
      + '<p class="audio-note">Lecture à voix de synthèse, générée à partir des informations de cette fiche.</p></div>';
    var tag = tagPalette(color);
    html += '<span class="d-tag" style="background:'+tag.bg+';color:'+tag.text+'">'+escapeHtml(ACTIVITES[r[F.ACT]])+'</span><br>';
    if(r._accessUnknown || known===0) html += '<div class="d-access-score d-access-unknown"><strong>?</strong> <span><b>Informations non renseignées</b> pour ce lieu.<br><span class="d-access-score-note">L’absence d’information ne signifie ni accessible ni inaccessible.</span></span></div>';
    else html += '<div class="d-access-score"><strong>'+completenessLabel(known)+'</strong> <span><b>Complétude des informations</b> ('+known+' dimensions sur 6 renseignées).<br><span class="d-access-score-note">Ce nombre décrit les informations présentes, pas les conditions d’accès. Les critères ci-dessous sont ceux déclarés par les sources.</span></span></div>';
    if(r[F.SITE]) html += '<a class="d-link" href="'+escapeAttr(safeExternalUrl(r[F.SITE]))+'" target="_blank" rel="noopener noreferrer" title="Voir le site de '+escapeAttr(r[F.NOM])+' (nouvelle fenêtre)">'+icon('link')+' Voir le site du lieu<span class="sr-only"> '+escapeHtml(r[F.NOM])+' (s’ouvre dans une nouvelle fenêtre)</span></a>';
    html += '<div id="detailEnrichment" class="d-enrichment" aria-live="polite" aria-busy="true"></div>';
    if(profileState && roleOf(profileState)==='admin'){
      var remotePlace=null;
      if(r._hiliaPlaceId){ remotePlace={id:r._hiliaPlaceId}; }
      // Compatibilité avec les fiches personnalisées plus anciennes qui n’ont pas encore leur identifiant sur la ligne.
      if(!remotePlace){ remotePlace=getApprovedPlaces().find(function(p){return normalize(p.name)===normalize(r[F.NOM]) && normalize(p.address)===normalize(r[F.ADR]) && String(p.cp||'').trim()===String(r[F.CP]||'').trim() && normalize(p.activity)===normalize(ACTIVITES[r[F.ACT]]);})||null; }
      if(remotePlace && remotePlace.id) html += '<div class="detail-contrib-actions"><button type="button" class="detail-action-btn" id="copyPlaceLinkBtn">Copier le lien de cette fiche</button><button type="button" class="detail-action-btn" id="deletePlaceBtn" data-place-id="'+escapeAttr(remotePlace.id)+'" style="color:#8C2C24;border-color:#E2AAA4">Supprimer ce lieu</button></div>';
    }

    var labels = publicLabels(parseListField(r[F.LABELS]));
    var familles = parseListField(r[F.FAMILLES]).map(function(f){ return FAMILLE_LABELS[f]||''; }).filter(Boolean);
    if(labels.length || familles.length){
      html += '<div class="d-section"><h3>Labels & reconnaissance</h3><div class="d-badges">';
      labels.forEach(function(l){ html += '<span class="d-badge">'+escapeHtml(l)+'</span>'; });
      familles.forEach(function(f){ html += '<span class="d-badge">'+escapeHtml(f)+'</span>'; });
      html += '</div></div>';
    }
    html += '<div class="d-section"><h3>Stationnement & abords</h3><div class="d-grid" role="list">';
    html += dItem(r[F.TRANSPORT],'Transport en commun à proximité');
    html += dItem(r[F.STATIONNEMENT],'Stationnement disponible');
    html += dItem(r[F.STATIONNEMENT_PMR],'Places de stationnement PMR');
    html += dItem(r[F.STATIONNEMENT_EXT],'Stationnement extérieur disponible');
    html += dItem(r[F.STATIONNEMENT_EXT_PMR],'Places de stationnement extérieur PMR');
    html += '</div></div>';
    html += '<div class="d-section"><h3>Cheminement extérieur</h3><div class="d-grid" role="list">';
    html += dItem(r[F.CHEMIN_PLAIN_PIED],'Cheminement de plain-pied');
    html += dItem(r[F.CHEMIN_TERRAIN_STABLE],'Terrain stable');
    html += dItem(r[F.CHEMIN_REPERAGE],'Repérage des marches');
    html += dItem(r[F.CHEMIN_MAIN_COURANTE],'Main courante');
    html += dItem(r[F.CHEMIN_RAMPE],"Rampe d'accès");
    html += dItem(r[F.CHEMIN_BANDE_GUIDAGE],'Bande de guidage (malvoyants)');
    html += '</div></div>';
    html += '<div class="d-section"><h3>Entrée</h3><div class="d-grid" role="list">';
    html += dItem(r[F.ENTREE_REPERABLE],'Entrée facilement repérable');
    html += dItem(r[F.ENTREE_PLAIN_PIED],'Entrée de plain-pied');
    if(r[F.ENTREE_MARCHES]!=null) html += dNum('Nombre de marches à l’entrée', r[F.ENTREE_MARCHES]);
    html += dItem(r[F.ENTREE_ASCENSEUR],'Ascenseur');
    html += dItem(r[F.ENTREE_RAMPE],"Rampe d'accès");
    html += dItem(r[F.ENTREE_DISPOSITIF_APPEL],"Dispositif d'appel");
    html += dItem(r[F.ENTREE_BALISE_SONORE],'Balise sonore');
    html += dItem(r[F.ENTREE_AIDE_HUMAINE],'Aide humaine possible sur demande');
    if(r[F.ENTREE_LARGEUR]) html += dNum('Largeur minimale de l’entrée', r[F.ENTREE_LARGEUR]+' cm');
    html += dItem(r[F.ENTREE_SPECIFIQUE_PMR],'Entrée spécifique PMR');
    html += '</div></div>';
    html += '<div class="d-section"><h3>Accueil</h3><div class="d-grid" role="list">';
    html += dItem(r[F.ACCUEIL_PERSONNEL],"Personnel présent à l'accueil");
    html += dItem(r[F.ACCUEIL_AUDIODESCR],'Audiodescription disponible');
    html += dItem(r[F.ACCUEIL_EQUIP_MALENT],'Équipements pour malentendants');
    html += dItem(r[F.ACCUEIL_PLAIN_PIED],"Cheminement de plain-pied à l'accueil");
    html += dItem(r[F.ACCUEIL_SIGNALETIQUE],'Signalétique intérieure adaptée');
    html += '</div></div>';
    html += '<div class="d-section"><h3>Sanitaires</h3><div class="d-grid" role="list">';
    html += dItem(r[F.SANITAIRES_DISPO],'Sanitaires disponibles au public');
    html += dItem(r[F.SANITAIRES_PMR],'Sanitaires adaptés PMR');
    html += '</div></div>';
    if(r[F.CONFORMITE]!=null) html += `<div class="disclaimer">Conformité réglementaire déclarée par l'établissement&nbsp;: ${isTrue(r[F.CONFORMITE])?'oui':'non'}.</div>`;
    html += qualifHtml(r._hiliaQualif || r[F.QUALIF]);
    html += reviewsHtml(di);

    detailContent.innerHTML = html;
    // URL partageable par lieu : hash stable basé sur un slug lisible + identifiant.
    var slug = makePlaceSlug(r);
    var detailPath=placePath(slug);
    if(history && history.pushState){
      // Nouvelle entrée d’historique : le bouton Retour referme la fiche au lieu
      // de quitter le site. Un simple rafraîchissement de la même fiche ne crée
      // pas de doublon.
      if(location.pathname!==detailPath) history.pushState({page:'explore',place:slug},'',detailPath);
      else history.replaceState({page:'explore',place:slug},'',detailPath);
    }
    syncPlaceMeta(r,slug);
    var copyLinkBtn=detailContent.querySelector('#copyPlaceLinkBtn');
    if(copyLinkBtn) copyLinkBtn.addEventListener('click',function(){ var url=location.href; if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(function(){announce('Lien de la fiche copié.',100);}).catch(function(){prompt('Copiez le lien de cette fiche :',url);}); } else prompt('Copiez le lien de cette fiche :',url); });
    var deleteBtn=detailContent.querySelector('#deletePlaceBtn');
    if(deleteBtn) deleteBtn.addEventListener('click',async function(){
      if(!profileState || roleOf(profileState)!=='admin'){ announce('Action réservée aux administrateurs.',0); return; }
      if(!confirm('Supprimer définitivement « '+r[F.NOM]+' » ? Cette action est irréversible.')) return;
      deleteBtn.disabled=true;
      var del=await supabaseClient.from('hilia_places').delete().eq('id',deleteBtn.dataset.placeId);
      if(del.error){ deleteBtn.disabled=false; announce('Suppression impossible : '+del.error.message,0); return; }
      await loadRemoteContent(); closeDetail(); history.replaceState({page:'explore'},'',pagePath('explore')); location.reload();
    });
    var wasOpen = overlayBg.classList.contains('open');
    if(!wasOpen){ modalFocusReturn = trigger; detailPanel.scrollTop = 0; }
    overlayBg.classList.add('open'); detailPanel.classList.add('open');
    bindReviewActions(di);
    // Les avis de cette fiche arrivent à la demande : on rafraîchit l'affichage ensuite.
    ensureReviews([di], function(){ if(reviewsFor(di).length && overlayBg.classList.contains('open') && DATA[di]===r) openDetail(di,true); });
    AudioDesc.bind(di);
    hydratePlaceDetail(di, r, detailToken);
    if(keepOpen && wasOpen){ var rh = detailContent.querySelector('#reviewsHeading'); if(rh) rh.focus(); }
    else activateModal(detailPanel);
  }
  function closeDetail(){ if(typeof AudioDesc!=='undefined') AudioDesc.stop(true); overlayBg.classList.remove('open'); detailPanel.classList.remove('open'); if(slugFromPath(location.pathname)){ history.replaceState({page:'explore'},'',pagePath('explore')+location.search); syncPageMeta('explore'); } if(!drawer.classList.contains('open')) syncModalLock(); }
  document.getElementById('detailClose').addEventListener('click', closeDetail);
  overlayBg.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ closeDetail(); closeDrawer(); } });

  // =====================================================================
  // ---------- Qualification prestataires (formulaire, fiche, filtres, admin) ----------
  // =====================================================================
  var PROV_SECTIONS=[
{t:'1. Informations générales et contact',q:[
 {n:1,id:'structure_name',k:'text',l:'Nom de la structure / enseigne',r:1},
 {n:2,id:'activity_name',k:'text',l:'Nom de l’activité ou prestation qualifiée',r:1},
 {n:3,id:'address',k:'text',l:'Adresse exacte de l’activité',r:1,ac:'street-address'},
 {n:4,id:'website',k:'url',l:'Site web / page d’information',h:'Commençant par https://'},
 {n:5,id:'contact_name',k:'text',l:'Contact référent (nom, prénom, fonction)',r:1,ac:'name'},
 {n:6,id:'contact_email',k:'email',l:'Adresse e-mail de contact',r:1,ac:'email'},
 {n:7,id:'contact_phone',k:'tel',l:'Numéro de téléphone',ac:'tel'},
 {n:8,id:'category',k:'select',l:'Catégorie principale de l’activité',r:1,o:[['sport_aventure','Sport & Aventure'],['culture_patrimoine','Culture & Patrimoine'],['ateliers_creatifs','Ateliers & Loisirs créatifs'],['plein_air_nature','Plein air & Nature'],['bien_etre','Bien-être & Relaxation'],['spectacle_divertissement','Spectacle & Divertissement'],['autre','Autre']]}]},
{t:'2. Stationnement, abords et cheminement extérieur',q:[
 {n:9,id:'transport',k:'check',l:'Accès et transports en commun',o:[['tc_accessibles_200m','Transports en commun accessibles à proximité (< 200 m)'],['arret_non_garanti','Arrêt de bus / métro / RER à proximité (accessibilité non garantie)']]},
 {n:10,id:'parking',k:'check',l:'Stationnement et abords',o:[['parking_proche','Stationnement disponible à proximité'],['parking_pmr_50m','Places de stationnement PMR réservées (< 50 m)'],['parking_ext','Stationnement extérieur disponible'],['parking_ext_pmr','Places de stationnement extérieur PMR'],['depose_minute','Dépose-minute possible juste devant l’entrée']]},
 {n:11,id:'exterieur',k:'check',l:'Cheminement extérieur et sol',o:[['chemin_plain_pied','Cheminement de plain-pied (extérieur)'],['terrain_stable','Terrain stable et roulant'],['marches_reperees','Repérage visuel des marches'],['main_courante','Main courante présente'],['rampe_ext','Rampe d’accès extérieur'],['bande_guidage','Bande de guidage au sol pour malvoyants']]}]},
{t:'3. Entrée, accueil et données physiques',q:[
 {n:12,id:'entree',k:'check',l:'Accès à l’entrée principale',o:[['entree_reperable','Entrée facilement repérable'],['entree_plain_pied','Entrée de plain-pied'],['entree_pmr','Entrée spécifique PMR'],['entree_rampe','Rampe d’accès entrée'],['ascenseur','Ascenseur ou élévateur adapté'],['appel','Dispositif d’appel à l’entrée'],['balise_sonore','Balise sonore à l’entrée'],['aide_humaine','Aide humaine possible à l’entrée']]},
 {n:13,id:'marches_entree',k:'number',l:'Nombre de marches à l’entrée',h:'Indiquez 0 s’il n’y en a pas',min:0,max:200},
 {n:14,id:'marches_interieur',k:'number',l:'Nombre de marches sur le cheminement intérieur',h:'Indiquez 0 s’il n’y en a pas',min:0,max:500},
 {n:15,id:'largeur_min_cm',k:'number',l:'Largeur minimale de l’entrée et des portes (en cm)',h:'Un fauteuil roulant a besoin d’au moins 80 cm',min:20,max:500},
 {n:16,id:'accueil',k:'check',l:'Accueil et équipements du bâtiment',o:[['personnel_accueil','Personnel présent à l’accueil'],['accueil_plain_pied','Cheminement de plain-pied à l’accueil'],['signaletique','Signalétique intérieure adaptée et lisible'],['audiodescription','Audiodescription disponible'],['bim_accueil','Équipements pour malentendants (boucle à induction magnétique)']]},
 {n:17,id:'sanitaires',k:'radio',l:'Sanitaires',o:[['publics_pmr','Sanitaires disponibles au public ET adaptés PMR'],['publics_non_pmr','Sanitaires disponibles au public mais NON adaptés PMR'],['pmr_proximite','Sanitaires publics adaptés à proximité immédiate (< 50 m)'],['aucun','Pas de sanitaires disponibles']]}]},
{t:'4. Pratique de l’activité',q:[
 {n:18,id:'participation',k:'radio',l:'Participation effective à l’activité de loisir',o:[['fauteuil_autonome','Activité réalisable en fauteuil roulant de manière autonome'],['fauteuil_accompagne','Réalisable en fauteuil avec accompagnateur ou équipement adapté'],['transfert','Nécessite un transfert autonome ou assisté'],['debout_obligatoire','L’activité elle-même nécessite d’être debout / mobile']]}]},
{t:'5. Vision, audition et communication',q:[
 {n:19,id:'visuel',k:'check',l:'Accessibilité visuelle et communication',o:[['contrastes','Signalétique lisible à forts contrastes'],['obstacles_balises','Obstacles et changements de niveau clairement balisés au sol'],['eclairage','Éclairage homogène sans zones d’ombre brutales'],['tactile_braille','Supports tactiles, braille ou maquettes disponibles'],['audiodesc_visite','Audiodescription ou visite guidée adaptée disponible']]},
 {n:20,id:'auditif',k:'check',l:'Accessibilité auditive et consignes',o:[['consignes_ecrites','Consignes de sécurité disponibles par écrit ou visuels'],['resa_sans_appel','Réservation et demandes d’informations possibles sans appel téléphonique'],['bim','Boucle à induction magnétique (BIM) installée'],['sous_titres','Supports sous-titrés ou retranscrits par écrit'],['personnel_lsf','Personnel formé / sensibilisé à la LSF ou à la communication bienveillante']]}]},
{t:'6. Compréhension et confort sensoriel',q:[
 {n:21,id:'cognitif',k:'check',l:'Compréhension et repérage',o:[['deroulement_clair','Déroulement et règles de l’activité présentés clairement avant le début'],['langage_clair','Consignes rédigées en langage clair (sans jargon technique)'],['falc','Supports en FALC (Facile À Lire et à Comprendre) disponibles'],['plan_simple','Plan ou repères visuels simples pour s’orienter sur place']]},
 {n:22,id:'sensoriel',k:'check',l:'Confort sensoriel et neurodiversité',o:[['son_modere','Ambiance sonore modérée ou contrôlée'],['pas_flash','Pas d’effets lumineux brutaux (stroboscopes, flashs) non signalés'],['espace_calme','Espace calme ou zone de repli accessible en cas de besoin'],['pause_possible','Possibilité de faire une pause pendant l’activité'],['creneaux_calmes','Recommandation de créneaux horaires à faible affluence']]}]},
{t:'7. Effort, durée et conditions tarifaires',q:[
 {n:23,id:'effort',k:'radio',l:'Durée totale et niveau d’effort',o:[['moins_45min_tres_faible','Moins de 45 minutes / effort très faible'],['45min_1h30_modere','45 min à 1 h 30 / effort modéré'],['plus_1h30_continu','Plus de 1 h 30 / effort continu']]},
 {n:24,id:'assises',k:'check',l:'Assises et gestion de l’attente',o:[['sieges_parcours','Sièges ou bancs disponibles tout au long du parcours / de l’activité'],['file_prioritaire','File d’attente prioritaire ou gestion du temps d’attente'],['sieges_pliants','Prêt de sièges pliants ou cannes-sièges sur place']]},
 {n:25,id:'tarif_usager',k:'radio',l:'Conditions pour l’usager en situation de handicap',o:[['gratuit','Gratuité totale pour l’usager'],['reduit','Tarif réduit pour l’usager'],['plein','Plein tarif pour l’usager'],['non_applicable','Non applicable']]},
 {n:'25b',id:'tarif_usager_precisions',k:'textarea',l:'Précisions tarifaires et justificatifs demandés',h:'Facultatif. Ex. : carte mobilité inclusion, notification MDPH…'},
 {n:26,id:'tarif_accompagnateur',k:'radio',l:'Conditions pour l’accompagnateur',o:[['gratuit','Gratuité totale pour l’accompagnateur'],['reduit','Tarif réduit pour l’accompagnateur'],['plein','Plein tarif pour l’accompagnateur'],['non_applicable','Non applicable']]}]},
{t:'8. Pièces justificatives et engagement',q:[
 {n:27,id:'visuels',k:'file',l:'Photos de l’entrée, des sanitaires, du cheminement…',h:'Facultatif. 5 photos maximum, JPG, PNG ou WebP, 5 Mo chacune.'},
 {n:28,id:'remarques',k:'textarea',l:'Précisions complémentaires / remarques'},
 {n:'28b',id:'engagement_honneur',k:'honor',l:'Je certifie sur l’honneur que les informations fournies sont exactes et je m’engage à signaler tout changement.',r:1}]}
];

  function qHas(q,g,c){ return !!(q && q.checks && Array.isArray(q.checks[g]) && q.checks[g].indexOf(c)>-1); }
  function applyQualif(row,q){
    row[F.QUALIF]=q;
    row[F.Q_FAUTEUIL]=(q.participation==='fauteuil_autonome'||q.participation==='fauteuil_accompagne')?1:null;
    row[F.Q_FAUT_AUTONOME]=q.participation==='fauteuil_autonome'?1:null;
    row[F.Q_EFFORT_FAIBLE]=q.effort==='moins_45min_tres_faible'?1:null;
    row[F.Q_SIEGES]=qHas(q,'assises','sieges_parcours')?1:null;
    row[F.Q_ESPACE_CALME]=qHas(q,'sensoriel','espace_calme')?1:null;
    row[F.Q_PAS_FLASH]=qHas(q,'sensoriel','pas_flash')?1:null;
    row[F.Q_PAUSE]=qHas(q,'sensoriel','pause_possible')?1:null;
    row[F.Q_CRENEAUX]=qHas(q,'sensoriel','creneaux_calmes')?1:null;
    row[F.Q_FALC]=qHas(q,'cognitif','falc')?1:null;
    row[F.Q_RESA_SANS_APPEL]=qHas(q,'auditif','resa_sans_appel')?1:null;
    row[F.Q_BIM]=(qHas(q,'auditif','bim')||qHas(q,'accueil','bim_accueil'))?1:null;
    row[F.Q_AUDIODESC]=(qHas(q,'visuel','audiodesc_visite')||qHas(q,'accueil','audiodescription'))?1:null;
    row[F.Q_TARIF_AVANT]=(q.tarif_usager==='gratuit'||q.tarif_usager==='reduit')?1:null;
    row[F.Q_GRATUIT_ACCOMP]=q.tarif_accompagnateur==='gratuit'?1:null;
  }
  function provLabel(id,code){
    for(var s=0;s<PROV_SECTIONS.length;s++) for(var i=0;i<PROV_SECTIONS[s].q.length;i++){
      var q=PROV_SECTIONS[s].q[i]; if(q.id!==id||!q.o) continue;
      for(var j=0;j<q.o.length;j++) if(q.o[j][0]===code) return q.o[j][1];
    }
    return code;
  }
  function qualifHtml(q){
    if(!q) return '';
    function sec(title,inner){ return inner ? '<div class="d-section"><h3>'+title+'</h3><div class="d-grid" role="list">'+inner+'</div></div>' : ''; }
    function chk(g){
      var arr=(q.checks&&Array.isArray(q.checks[g]))?q.checks[g]:[], out='';
      arr.forEach(function(c){ out+=dItem(1,escapeHtml(provLabel(g,c))); });
      return out;
    }
    var h='';
    h+=sec('Pratique de l’activité',
      (q.participation?dNum('Participation à l’activité',provLabel('participation',q.participation)):'')+
      (q.marches_interieur!=null?dNum('Marches sur le cheminement intérieur',q.marches_interieur):''));
    h+=sec('Vision & communication',chk('visuel'));
    h+=sec('Audition & consignes',chk('auditif'));
    h+=sec('Compréhension & repérage',chk('cognitif'));
    h+=sec('Confort sensoriel',chk('sensoriel'));
    h+=sec('Durée, effort & assises',
      (q.effort?dNum('Durée et niveau d’effort',provLabel('effort',q.effort)):'')+chk('assises'));
    h+=sec('Tarifs & conditions',
      (q.tarif_usager?dNum('Usager',provLabel('tarif_usager',q.tarif_usager)):'')+
      (q.tarif_usager_precisions?dNum('Précisions',q.tarif_usager_precisions):'')+
      (q.tarif_accompagnateur?dNum('Accompagnateur',provLabel('tarif_accompagnateur',q.tarif_accompagnateur)):''));
    if(h) h+='<div class="disclaimer">Informations déclarées par le prestataire et relues par HILIA avant publication.</div>';
    return h;
  }

  // ---------- Formulaire prestataire ----------
  var PROV_BUILT=false;
  var PROV_CHECK_GROUPS=['transport','parking','exterieur','entree','accueil','visuel','auditif','cognitif','sensoriel','assises'];
  function initProviderForm(){
    if(PROV_BUILT) return; PROV_BUILT=true;
    var form=document.getElementById('provForm'), sum=document.getElementById('provSummary'), st=document.getElementById('provStatus');
    function req(q){ return q.r?' <span class="pf-req" aria-hidden="true">*</span>':''; }
    function hint(q){ return q.h?'<span class="pf-hint" id="pfh_'+q.id+'">'+escapeHtml(q.h)+'</span>':''; }
    var h='<div style="position:absolute;left:-9999px" aria-hidden="true"><label>Ne pas remplir<input type="text" name="pf_hp" tabindex="-1" autocomplete="off"></label></div>';
    PROV_SECTIONS.forEach(function(s){
      h+='<fieldset class="pf-fs"><legend>'+escapeHtml(s.t)+'</legend>';
      s.q.forEach(function(q){
        var i=q.id, fid='pf_'+i, d=q.h?' aria-describedby="pfh_'+i+'"':'', rq=q.r?' required aria-required="true"':'';
        h+='<div class="pf-q">';
        if(q.k==='check'||q.k==='radio'){
          h+='<fieldset style="border:0;padding:0;margin:0;min-width:0"><legend class="pf-lbl" style="font-weight:650;padding:0;margin-bottom:6px">'+escapeHtml(q.l)+req(q)+'</legend>'+hint(q);
          q.o.forEach(function(o,j){ var id=fid+'_'+j;
            h+='<div class="pf-opt"><input type="'+(q.k==='check'?'checkbox':'radio')+'" name="'+i+'" id="'+id+'" value="'+o[0]+'"><label for="'+id+'">'+escapeHtml(o[1])+'</label></div>'; });
          h+='</fieldset>';
        } else if(q.k==='honor'){
          h+='<div class="pf-opt"><input type="checkbox" id="'+fid+'" name="'+i+'" required aria-required="true"><label for="'+fid+'">'+escapeHtml(q.l)+req(q)+'</label></div>';
        } else {
          h+='<label for="'+fid+'">'+escapeHtml(q.l)+req(q)+'</label>'+hint(q);
          if(q.k==='select') h+='<select id="'+fid+'" name="'+i+'"'+rq+'><option value="">Choisir…</option>'+q.o.map(function(o){return '<option value="'+o[0]+'">'+escapeHtml(o[1])+'</option>';}).join('')+'</select>';
          else if(q.k==='textarea') h+='<textarea id="'+fid+'" name="'+i+'"'+d+'></textarea>';
          else if(q.k==='file') h+='<input type="file" id="'+fid+'" name="'+i+'" accept="image/jpeg,image/png,image/webp" multiple'+d+'>';
          else if(q.k==='number') h+='<input type="number" inputmode="numeric" id="'+fid+'" name="'+i+'" min="'+q.min+'" max="'+q.max+'"'+d+'>';
          else h+='<input type="'+q.k+'" id="'+fid+'" name="'+i+'"'+(q.ac?' autocomplete="'+q.ac+'"':'')+rq+d+'>';
        }
        h+='<div class="pf-err" id="pfe_'+i+'" hidden></div></div>';
      });
      h+='</fieldset>';
    });
    h+='<button type="submit" class="pf-submit" id="pfSend">Envoyer mon formulaire</button>';
    form.innerHTML=h;

    function val(id){ var e=form.elements[id]; return e && e.value && e.value.trim() ? e.value.trim() : null; }
    function num(id){ var v=val(id); return v===null?null:parseInt(v,10); }
    function checked(id){ return Array.prototype.map.call(form.querySelectorAll('input[name="'+id+'"]:checked'),function(e){return e.value;}); }
    function uuid(){ return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);}); }

    function validate(){
      var errs=[];
      PROV_SECTIONS.forEach(function(s){ s.q.forEach(function(q){
        var box=document.getElementById('pfe_'+q.id), m='';
        if(q.r && (q.k==='honor' ? !form.elements[q.id].checked : !val(q.id))) m='Ce champ est obligatoire.';
        else if(q.k==='email' && val(q.id) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val(q.id))) m='Adresse e-mail invalide.';
        else if(q.k==='url' && val(q.id) && !/^https?:\/\/.+\..+/.test(val(q.id))) m='Adresse invalide : elle doit commencer par https://';
        else if(q.k==='number' && val(q.id)){ var n=num(q.id); if(isNaN(n)||n<q.min||n>q.max) m='Entrez un nombre entre '+q.min+' et '+q.max+'.'; }
        else if(q.k==='file' && form.elements[q.id].files.length){
          var f=form.elements[q.id].files;
          if(f.length>5) m='5 photos maximum.';
          for(var i=0;i<f.length;i++) if(f[i].size>5242880) m='« '+f[i].name+' » dépasse 5 Mo.';
        }
        box.hidden=!m; box.textContent=m;
        if(m) errs.push({id:q.id,l:q.l,m:m,kind:q.k});
      }); });
      return errs;
    }
    sum.addEventListener('click',function(e){
      var a=e.target.closest('[data-pf-go]'); if(!a) return; e.preventDefault();
      var t=document.getElementById(a.dataset.pfGo); if(t){ t.scrollIntoView({block:'center'}); t.focus(); }
    });

    form.addEventListener('submit',async function(ev){
      ev.preventDefault();
      var errs=validate();
      if(errs.length){
        sum.hidden=false;
        sum.innerHTML='<strong>'+errs.length+' erreur'+(errs.length>1?'s':'')+' à corriger :</strong><ul>'+errs.map(function(e){
          var target='pf_'+e.id+((e.kind==='radio'||e.kind==='check')?'_0':'');
          return '<li><a href="#" data-pf-go="'+target+'">'+escapeHtml(e.l)+'</a> - '+escapeHtml(e.m)+'</li>'; }).join('')+'</ul>';
        sum.focus(); return;
      }
      sum.hidden=true;
      if(form.elements.pf_hp && form.elements.pf_hp.value){ form.hidden=true; st.innerHTML='<div class="pf-done"><h2>Merci.</h2></div>'; return; }
      if(!supabaseClient){ st.innerHTML='<p class="pf-err">Service indisponible. Réessayez plus tard.</p>'; return; }
      var btn=document.getElementById('pfSend'); btn.disabled=true; st.textContent='Envoi en cours…';
      try{
        var id=uuid(), paths=[], files=form.elements.visuels.files;
        for(var i=0;i<files.length;i++){
          var ext=(files[i].name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
          var p=id+'/'+(i+1)+'.'+ext;
          var up=await supabaseClient.storage.from('provider-visuals').upload(p,files[i],{contentType:files[i].type});
          if(up.error) throw up.error; paths.push(p);
        }
        var checks={}; PROV_CHECK_GROUPS.forEach(function(g){ checks[g]=checked(g); });
        var radio=function(n){ return checked(n)[0]||null; };
        var row={id:id,structure_name:val('structure_name'),activity_name:val('activity_name'),address:val('address'),website:val('website'),
          contact_name:val('contact_name'),contact_email:val('contact_email'),contact_phone:val('contact_phone'),category:val('category'),
          checks:checks,marches_entree:num('marches_entree'),marches_interieur:num('marches_interieur'),largeur_min_cm:num('largeur_min_cm'),
          sanitaires:radio('sanitaires'),participation:radio('participation'),effort:radio('effort'),
          tarif_usager:radio('tarif_usager'),tarif_usager_precisions:val('tarif_usager_precisions'),tarif_accompagnateur:radio('tarif_accompagnateur'),
          visuels:paths,remarques:val('remarques'),engagement_honneur:true,status:'pending'};
        var ins=await supabaseClient.from('hilia_provider_submissions').insert(row);
        if(ins.error) throw ins.error;
        form.hidden=true;
        st.innerHTML='<div class="pf-done" tabindex="-1" id="pfOk"><h2>Merci, votre formulaire est bien envoyé.</h2><p>L’équipe HILIA le vérifie et vous recontacte par e-mail avant la publication de la fiche.</p><p><a href="#explore" data-nav-page="explore">Retour à l’exploration</a></p></div>';
        var okLink=st.querySelector('[data-nav-page]'); if(okLink) okLink.addEventListener('click',function(e){ e.preventDefault(); navigatePage('explore',true); });
        document.getElementById('pfOk').focus(); window.scrollTo(0,0);
      }catch(e){
        console.error(e); btn.disabled=false;
        st.innerHTML='<p class="pf-err" role="alert">L’envoi a échoué. Vérifiez votre connexion et réessayez ; vos réponses sont conservées sur cette page.</p>';
      }
    });
  }

  // ---------- Admin : validation des qualifications ----------
  var PROV_SUBS={};
  function provBuildAccess(s){
    var c=s.checks||{}, A={};
    function has(g,k){ return Array.isArray(c[g]) && c[g].indexOf(k)>-1; }
    [['transport','tc_accessibles_200m',F.TRANSPORT],['parking','parking_proche',F.STATIONNEMENT],['parking','parking_pmr_50m',F.STATIONNEMENT_PMR],
     ['parking','parking_ext',F.STATIONNEMENT_EXT],['parking','parking_ext_pmr',F.STATIONNEMENT_EXT_PMR],
     ['exterieur','chemin_plain_pied',F.CHEMIN_PLAIN_PIED],['exterieur','terrain_stable',F.CHEMIN_TERRAIN_STABLE],['exterieur','marches_reperees',F.CHEMIN_REPERAGE],
     ['exterieur','main_courante',F.CHEMIN_MAIN_COURANTE],['exterieur','rampe_ext',F.CHEMIN_RAMPE],['exterieur','bande_guidage',F.CHEMIN_BANDE_GUIDAGE],
     ['entree','entree_reperable',F.ENTREE_REPERABLE],['entree','entree_plain_pied',F.ENTREE_PLAIN_PIED],['entree','ascenseur',F.ENTREE_ASCENSEUR],
     ['entree','entree_rampe',F.ENTREE_RAMPE],['entree','appel',F.ENTREE_DISPOSITIF_APPEL],['entree','balise_sonore',F.ENTREE_BALISE_SONORE],
     ['entree','aide_humaine',F.ENTREE_AIDE_HUMAINE],['entree','entree_pmr',F.ENTREE_SPECIFIQUE_PMR],
     ['accueil','personnel_accueil',F.ACCUEIL_PERSONNEL],['accueil','audiodescription',F.ACCUEIL_AUDIODESCR],['accueil','bim_accueil',F.ACCUEIL_EQUIP_MALENT],
     ['accueil','accueil_plain_pied',F.ACCUEIL_PLAIN_PIED],['accueil','signaletique',F.ACCUEIL_SIGNALETIQUE]
    ].forEach(function(m){ if(has(m[0],m[1])) A[m[2]]=1; });
    if(s.sanitaires==='publics_pmr'){ A[F.SANITAIRES_DISPO]=1; A[F.SANITAIRES_PMR]=1; }
    else if(s.sanitaires==='publics_non_pmr'){ A[F.SANITAIRES_DISPO]=1; A[F.SANITAIRES_PMR]=0; }
    else if(s.sanitaires==='pmr_proximite'){ A[F.SANITAIRES_DISPO]=0; }
    else if(s.sanitaires==='aucun'){ A[F.SANITAIRES_DISPO]=0; A[F.SANITAIRES_PMR]=0; }
    if(s.marches_entree!=null) A[F.ENTREE_MARCHES]=s.marches_entree;
    if(s.marches_interieur!=null) A[F.CHEMIN_MARCHES]=s.marches_interieur;
    if(s.largeur_min_cm!=null) A[F.ENTREE_LARGEUR]=s.largeur_min_cm;
    return A;
  }
  function provBuildQualif(s){
    return {participation:s.participation,effort:s.effort,tarif_usager:s.tarif_usager,tarif_usager_precisions:s.tarif_usager_precisions||null,
      tarif_accompagnateur:s.tarif_accompagnateur,marches_interieur:s.marches_interieur,checks:s.checks||{},category:s.category,sanitaires:s.sanitaires,source:'prestataire'};
  }
  async function provGeocode(addr){
    try{
      var r=await fetch('https://api-adresse.data.gouv.fr/search/?limit=1&q='+encodeURIComponent(addr));
      var j=await r.json(); var f=j&&j.features&&j.features[0]; if(!f) return null;
      return {lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0],cp:f.properties.postcode||'',commune:f.properties.city||''};
    }catch(e){ return null; }
  }
  function provMsg(id,text){ var e=document.getElementById('psmsg_'+id); if(e) e.textContent=text; announce(text,0); }
  async function loadProvSubs(box){
    var list=box.querySelector('#provSubList'); if(!list||!supabaseClient) return;
    var r=await supabaseClient.from('hilia_provider_submissions').select('*').eq('status','pending').order('created_at',{ascending:false});
    if(r.error){ list.innerHTML='<div class="admin-item"><div class="admin-item-main"><p>Qualifications indisponibles (migration SQL exécutée ?) : '+escapeHtml(r.error.message)+'</p></div></div>'; return; }
    var rows=r.data||[]; PROV_SUBS={};
    if(!rows.length){ list.innerHTML='<div class="admin-item"><div class="admin-item-main"><strong>Aucune qualification en attente</strong><p>Les formulaires envoyés depuis « Référencer mon activité » apparaîtront ici.</p></div></div>'; return; }
    var opts='<option value="">Choisir…</option>'+ACTIVITES.map(function(a){return '<option value="'+escapeAttr(a)+'">'+escapeHtml(a)+'</option>';}).join('');
    list.innerHTML=rows.map(function(s){
      PROV_SUBS[s.id]=s;
      var n=0; Object.keys(s.checks||{}).forEach(function(g){ n+=(s.checks[g]||[]).length; });
      var m=String(s.address||'').match(/(\d{5})\s+([^,]+)$/);
      return '<div class="admin-item"><div class="admin-item-main"><strong>'+escapeHtml(s.structure_name)+' · '+escapeHtml(s.activity_name)+'</strong>'+
        '<p>'+escapeHtml(s.address)+'<br>'+escapeHtml(s.contact_name)+' · '+escapeHtml(s.contact_email)+(s.contact_phone?' · '+escapeHtml(s.contact_phone):'')+
        '<br><small>'+n+' critères cochés · '+(s.visuels||[]).length+' photo(s) · '+formatDate(s.created_at)+'</small>'+
        (s.remarques?'<br><small>Remarque : '+escapeHtml(s.remarques)+'</small>':'')+'</p>'+
        '<div class="prov-extra"><label>Catégorie d’activité *<select data-ps-act="'+s.id+'">'+opts+'</select></label>'+
        '<label>Code postal<input data-ps-cp="'+s.id+'" inputmode="numeric" value="'+escapeAttr(m?m[1]:'')+'"></label>'+
        '<label>Commune<input data-ps-com="'+s.id+'" value="'+escapeAttr(m?m[2].trim():'')+'"></label></div>'+
        '<div class="prov-photos" id="psph_'+s.id+'" aria-live="polite"></div><div class="pf-err" id="psmsg_'+s.id+'" role="alert" style="color:#A31515;font-weight:650;margin-top:6px"></div></div>'+
        '<div class="admin-item-actions">'+
        ((s.visuels||[]).length?'<button class="small-btn" type="button" data-ps-photos="'+s.id+'">Voir les photos</button>':'')+
        '<button class="small-btn primary" type="button" data-ps-ok="'+s.id+'">Publier</button>'+
        '<button class="small-btn" type="button" data-ps-no="'+s.id+'">Refuser</button></div></div>';
    }).join('');
    list.querySelectorAll('[data-ps-photos]').forEach(function(b){ b.addEventListener('click',async function(){
      var s=PROV_SUBS[b.dataset.psPhotos], holder=document.getElementById('psph_'+s.id);
      var sg=await supabaseClient.storage.from('provider-visuals').createSignedUrls(s.visuels,3600);
      if(sg.error){ holder.textContent='Photos inaccessibles : '+sg.error.message; return; }
      holder.innerHTML=sg.data.map(function(x,i){ return x.signedUrl?'<a href="'+escapeAttr(x.signedUrl)+'" target="_blank" rel="noopener noreferrer">Photo '+(i+1)+'<span class="sr-only"> (nouvelle fenêtre)</span></a>':''; }).join(' · ');
    }); });
    list.querySelectorAll('[data-ps-no]').forEach(function(b){ b.addEventListener('click',async function(){
      b.disabled=true;
      var u=await supabaseClient.from('hilia_provider_submissions').update({status:'rejected'}).eq('id',b.dataset.psNo);
      if(u.error){ announce('Refus impossible : '+u.error.message,0); b.disabled=false; return; }
      loadProvSubs(box);
    }); });
    list.querySelectorAll('[data-ps-ok]').forEach(function(b){ b.addEventListener('click',async function(){
      var id=b.dataset.psOk, s=PROV_SUBS[id];
      var act=list.querySelector('[data-ps-act="'+id+'"]').value;
      if(!act){ announce('Choisissez une catégorie d’activité avant de publier.',0); list.querySelector('[data-ps-act="'+id+'"]').focus(); return; }
      var cp=list.querySelector('[data-ps-cp="'+id+'"]').value.trim(), com=list.querySelector('[data-ps-com="'+id+'"]').value.trim();
      b.disabled=true;
      var geo=await provGeocode(s.address);
      if(!cp&&geo) cp=geo.cp; if(!com&&geo) com=geo.commune;
      var name=(s.structure_name===s.activity_name||normalize(s.activity_name).indexOf(normalize(s.structure_name))>-1)?s.activity_name:(s.structure_name+' '+s.activity_name).replace(/[\u2014\u2013]/g,' ').replace(/\s+/g,' ').trim();
      var row={id:'place_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:name,activity:act,address:s.address,cp:cp,commune:com||'Commune à préciser',
        site:s.website||null,lat:geo?geo.lat:null,lon:geo?geo.lon:null,reason:null,author:null,author_name:s.structure_name,status:'approved',
        approved_at:new Date().toISOString(),updated_at:new Date().toISOString(),access:provBuildAccess(s),qualif:provBuildQualif(s)};
      var ins=await supabaseClient.from('hilia_places').insert(row), warned=false;
      if(ins.error && /qualif/i.test(ins.error.message)){
        var row2=Object.assign({},row); delete row2.qualif;
        ins=await supabaseClient.from('hilia_places').insert(row2);
        if(!ins.error){ warned=true; provMsg(id,'Lieu publié SANS le détail de qualification : Supabase ne reconnaît pas encore la colonne « qualif ». Lancez la commande SQL indiquée dans les explications, puis republiez.'); }
      }
      if(ins.error){ console.error(ins.error); provMsg(id,'Publication impossible : '+ins.error.message); b.disabled=false; return; }
      var up=await supabaseClient.from('hilia_provider_submissions').update({status:'approved'}).eq('id',id);
      if(up.error){ warned=true; provMsg(id,'Lieu publié, mais le statut de la demande n’a pas pu être mis à jour : '+up.error.message); }
      if(warned) await new Promise(function(r){ setTimeout(r,6000); });
      await loadRemoteContent(); location.reload();
    }); });
  }

  // ---------- Agenda (événements distincts des lieux) ----------
  var agendaData = null, agendaPromise = null, agendaBound = false, agendaLimit = 40;
  var eventDetailCache = Object.create(null), eventDetailPromises = Object.create(null);
  function eventDetailShard(id){ return detailShard(id, 128); }
  function eventDateLabel(value){
    if(!value) return '';
    var p=String(value).split('-').map(Number);
    if(p.length!==3 || !p[0] || !p[1] || !p[2]) return String(value);
    return new Date(Date.UTC(p[0],p[1]-1,p[2])).toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  }
  function eventDateBadge(value){
    var p=String(value || '').split('-').map(Number);
    if(p.length!==3) return {day:'',month:''};
    var d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
    return {day:String(p[2]),month:d.toLocaleDateString('fr-FR',{month:'short',timeZone:'UTC'})};
  }
  function eventRange(dates){
    if(!dates) return '';
    var a=eventDateLabel(dates.start), b=eventDateLabel(dates.end);
    return a===b ? a : 'Du '+a+' au '+b;
  }
  function localTodayIso(){
    var d=new Date();
    var m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
    return d.getFullYear()+'-'+m+'-'+day;
  }
  function eventRanges(e){
    var periods=e && e.periods && e.periods.length ? e.periods : [{start:e && e.start,end:e && e.end}];
    return periods.filter(function(p){ return p && (p.start || p.end); }).map(function(p){
      return {start:p.start || p.end, end:p.end || p.start, startTime:p.startTime || null};
    });
  }
  function eventFuturePeriods(e, today){
    var day=today || localTodayIso();
    return eventRanges(e).filter(function(p){ return p.end >= day; }).sort(function(a,b){
      return a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
    });
  }
  function eventNextPeriod(e, today){
    return eventFuturePeriods(e, today)[0] || null;
  }
  function eventCardDateLabel(e, today){
    var day=today || localTodayIso();
    var future=eventFuturePeriods(e, day), next=future[0];
    if(!next) return 'Événement terminé';
    var remaining=future.length;
    if(next.start <= day && next.end >= day){
      return 'En cours · jusqu’au '+eventDateLabel(next.end)+(remaining>1?' · '+remaining+' dates à venir':'');
    }
    return (remaining>1?'Prochaine date : ':'')+eventRange(next)+(remaining>1?' · '+remaining+' dates à venir':'');
  }
  function eventMatchesDates(e,from,to){
    return eventRanges(e).some(function(p){
      return (!from || p.end>=from) && (!to || p.start<=to);
    });
  }
  function agendaQuickRange(mode){
    var today=localTodayIso();
    if(mode==='all') return {from:'',to:''};
    if(mode==='today') return {from:today,to:today};
    if(mode==='week') return {from:today,to:addDaysIso(today,6)};
    if(mode==='weekend'){
      var p=today.split('-').map(Number);
      var d=new Date(Date.UTC(p[0],p[1]-1,p[2]));
      var dow=d.getUTCDay(); // 0 = dimanche
      if(dow===0) return {from:today,to:today};
      if(dow===6) return {from:today,to:addDaysIso(today,1)};
      var sat=addDaysIso(today,6-dow);
      return {from:sat,to:addDaysIso(sat,1)};
    }
    return {from:'',to:''};
  }
  function addDaysIso(iso, days){
    var p=String(iso).split('-').map(Number);
    var d=new Date(Date.UTC(p[0],p[1]-1,p[2]+days));
    return d.toISOString().slice(0,10);
  }
  function loadAgendaData(){
    if(agendaData) return Promise.resolve(agendaData);
    if(!agendaPromise){
      agendaPromise=fetch('/data/events.json',{cache:'no-cache'})
        .then(function(res){ if(!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
        .then(function(data){ agendaData=data; return data; })
        .catch(function(err){ console.warn('HILIA : agenda indisponible',err); agendaPromise=null; return null; });
    }
    return agendaPromise;
  }
  function loadEventDetail(id){
    if(!id) return Promise.resolve(null);
    if(eventDetailCache[id]) return Promise.resolve(eventDetailCache[id]);
    var bucket=eventDetailShard(id);
    if(!eventDetailPromises[bucket]){
      eventDetailPromises[bucket]=fetch('/data/event-details/'+bucket+'.json',{cache:'no-cache'})
        .then(function(res){ return res.ok ? res.json() : null; })
        .then(function(ds){ if(ds && ds.events) Object.keys(ds.events).forEach(function(k){ eventDetailCache[k]=ds.events[k]; }); return true; })
        .catch(function(){ return false; });
    }
    return eventDetailPromises[bucket].then(function(){ return eventDetailCache[id] || null; });
  }
  function agendaFiltered(){
    if(!agendaData) return [];
    var where=normalize(document.getElementById('agendaWhere')?.value || '');
    var what=normalize(document.getElementById('agendaWhat')?.value || '');
    var family=document.getElementById('agendaFamily')?.value || '';
    var access=document.getElementById('agendaAccess')?.value || '';
    var from=document.getElementById('agendaFrom')?.value || '';
    var to=document.getElementById('agendaTo')?.value || '';
    var free=!!document.getElementById('agendaFree')?.checked;
    var today=localTodayIso();
    if(from && to && from>to){ var swap=from; from=to; to=swap; }
    var effectiveFrom=from || today;
    return agendaData.events.filter(function(e){
      // La date de consultation est la référence : un événement dont toutes les
      // occurrences sont passées n'apparaît jamais dans la vue par défaut.
      if(!eventFuturePeriods(e, today).length) return false;
      if(family && e.family!==family) return false;
      if(access==='declared' && e.accessibilityStatus!=='declared') return false;
      if(access==='unknown' && e.accessibilityStatus!=='unknown') return false;
      if(free && e.free!==true) return false;
      if((effectiveFrom || to) && !eventMatchesDates(e,effectiveFrom,to)) return false;
      if(where){
        // Une adresse contenant « rue de Paris » ne doit pas faire apparaître
        // un événement de Morlaix quand le visiteur cherche la ville de Paris.
        var place=normalize([e.commune,e.cp].filter(Boolean).join(' '));
        if(place.indexOf(where)===-1) return false;
      }
      if(what){
        // Le nom, la famille et les catégories seulement : une simple mention
        // dans une description ne fait pas apparaître un événement d'une autre ville.
        var content=normalize([e.name,e.family,(e.categories||[]).join(' ')].filter(Boolean).join(' '));
        if(content.indexOf(what)===-1) return false;
      }
      return true;
    }).sort(function(a,b){
      var pa=eventNextPeriod(a,today), pb=eventNextPeriod(b,today);
      var ka=pa ? (pa.start<=today ? '0000-00-00' : pa.start) : '9999-99-99';
      var kb=pb ? (pb.start<=today ? '0000-00-00' : pb.start) : '9999-99-99';
      return ka.localeCompare(kb) || String(a.name||'').localeCompare(String(b.name||''),'fr');
    });
  }
  function agendaPriceLabel(e){
    if(e.free===true) return 'Gratuit selon la source';
    if(e.free===false) return 'Tarifs déclarés';
    return '';
  }
  function agendaCard(e){
    var today=localTodayIso();
    var next=eventNextPeriod(e,today) || {start:e.start,end:e.end};
    var badgeDate=next.start<=today ? next.end : next.start;
    var b=eventDateBadge(badgeDate), price=agendaPriceLabel(e);
    var accessBadge=e.accessibilityStatus==='declared'
      ? '<span class="d-badge agenda-access-badge">Accessibilité déclarée</span>'
      : '<span class="d-badge agenda-access-unknown">Accessibilité non renseignée</span>';
    var html='<article class="agenda-card" data-agenda-card="'+escapeAttr(e.id)+'"><div class="agenda-date" aria-hidden="true"><span>'+escapeHtml(b.month)+'</span><b>'+escapeHtml(b.day)+'</b></div><div class="agenda-card-main"><h2>'+escapeHtml(e.name)+'</h2><p class="agenda-meta">'+escapeHtml(eventCardDateLabel(e,today))+(e.commune?' · '+escapeHtml(e.commune):'')+(e.cp?' ('+escapeHtml(e.cp)+')':'')+'</p><p class="agenda-tags">'+(e.family?'<span class="d-badge">'+escapeHtml(e.family)+'</span>':'')+(price?'<span class="d-badge agenda-free-badge">'+escapeHtml(price)+'</span>':'')+accessBadge+(e.source?'<span class="d-muted">Source : '+escapeHtml(e.source)+'</span>':'')+'</p><button type="button" class="secondary-btn agenda-toggle" data-agenda-toggle="'+escapeAttr(e.id)+'" aria-expanded="false">Voir le détail</button><div class="agenda-event-detail" hidden></div></div></article>';
    return html;
  }
  function agendaFreshnessLabel(generatedAt){
    if(!generatedAt) return 'date de mise à jour non fournie';
    var d=new Date(generatedAt);
    if(isNaN(d.getTime())) return 'date de mise à jour non fournie';
    var age=Math.floor((Date.now()-d.getTime())/86400000);
    return 'le '+d.toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})+(age>14?' · une actualisation des sources est à prévoir':'');
  }
  function syncAgendaQuick(){
    var from=document.getElementById('agendaFrom')?.value || '';
    var to=document.getElementById('agendaTo')?.value || '';
    document.querySelectorAll('[data-agenda-range]').forEach(function(btn){
      var r=agendaQuickRange(btn.getAttribute('data-agenda-range'));
      btn.classList.toggle('active', (r.from===from && r.to===to) || (btn.getAttribute('data-agenda-range')==='all' && !from && !to));
    });
  }
  function renderAgenda(){
    var list=document.getElementById('agendaList'), status=document.getElementById('agendaStatus'), count=document.getElementById('agendaCount'), label=document.getElementById('agendaCountLabel'), more=document.getElementById('agendaMore');
    if(!list || !status) return;
    if(!agendaData){
      status.textContent='L’agenda n’a pas pu être chargé. Réessayez dans un instant.';
      status.dataset.kind='error'; return;
    }
    var freshness=document.getElementById('agendaFreshness');
    if(freshness) freshness.textContent=agendaFreshnessLabel(agendaData.generatedAt);
    var rows=agendaFiltered();
    if(count) count.textContent=rows.length.toLocaleString('fr-FR');
    if(label) label.textContent=rows.length===1?'événement à venir':'événements à venir';
    status.dataset.kind='';
    status.textContent=rows.length?'':'Aucun événement à venir ne correspond à ces filtres. Élargissez la période ou la recherche.';
    list.innerHTML=rows.slice(0,agendaLimit).map(agendaCard).join('');
    if(more) more.hidden=rows.length<=agendaLimit;
    syncAgendaQuick();
    list.querySelectorAll('[data-agenda-toggle]').forEach(function(btn){ btn.addEventListener('click',function(){ toggleAgendaEvent(btn); }); });
  }
  function renderEventDetail(detail){
    var html='';
    if(detail.description) html+='<div class="d-description">'+paragraphsHtml(detail.description)+'</div>';
    var detailDates=detail.dates || {};
    var future=eventFuturePeriods(detailDates, localTodayIso());
    var next=future[0];
    if(!future.length){
      html+='<p class="d-source-line"><strong>Événement terminé</strong> · aucune occurrence à venir.</p>';
    } else {
      var ongoing=next.start<=localTodayIso() && next.end>=localTodayIso();
      var nextLabel=ongoing ? 'En cours · jusqu’au '+eventDateLabel(next.end) : 'Prochaine date : '+eventRange(next);
      html+='<p class="d-source-line"><strong>'+escapeHtml(nextLabel)+'</strong>'+(detailDates.startTime?' · '+escapeHtml(detailDates.startTime)+(detailDates.endTime?'–'+escapeHtml(detailDates.endTime):''):' · horaire non précisé par la source')+'</p>';
      if(future.length>1){
        var continuous=future.some(function(p){ return p.start!==p.end; });
        var upcoming=future.slice(0,13).map(function(p){ return eventRange(p); }).join(' · ');
        html+='<div class="d-section"><h3>'+(continuous?'Dates et périodes à venir':'Séances à venir')+'</h3><p class="d-source-line">'+escapeHtml(upcoming)+(future.length>13?' · …':'')+'</p><p class="d-source-line">'+(continuous?'Une période continue est distincte de séances ponctuelles.':'Chaque date correspond à une séance ponctuelle.')+'</p></div>';
      }
    }
    if(detail.address || detail.commune) html+='<p class="d-source-line">'+escapeHtml([detail.address,detail.cp,detail.commune].filter(Boolean).join(', '))+'</p>';
    html+=mediaGalleryHtml(detail.media, detail.name, CATEGORY_TEMPLATE[detail.categories?.[0]?.name] || 'general');
    if(detail.prices && detail.prices.items && detail.prices.items.length){
      html+='<div class="d-section d-practical"><h3>Tarifs</h3>'+(detail.prices.free===true?'<p class="d-price-summary">Gratuit selon la source.</p>':'')+'<ul class="d-prices">';
      detail.prices.items.forEach(function(item){ html+='<li>'+(item.label?'<span>'+escapeHtml(item.label)+'</span>':'<span>Tarif</span>')+(formatPriceItem(item)?'<b>'+escapeHtml(formatPriceItem(item))+'</b>':'')+'</li>'; });
      html+='</ul><p class="d-source-line">Tarifs déclarés, non garantis. Aucune disponibilité n’est déduite.</p></div>';
    }
    if(detail.contacts){
      var c=detail.contacts, has=(c.phones&&c.phones.length)||(c.emails&&c.emails.length)||(c.websites&&c.websites.length);
      if(has){ html+='<div class="d-section d-practical"><h3>Contact</h3><ul class="d-contacts">'; (c.phones||[]).forEach(function(p){html+='<li><span>Téléphone</span><a href="tel:'+escapeAttr(p)+'">'+escapeHtml(p)+'</a></li>';}); (c.emails||[]).forEach(function(m){html+='<li><span>E-mail</span><a href="mailto:'+escapeAttr(m)+'">'+escapeHtml(m)+'</a></li>';}); (c.websites||[]).forEach(function(u){var safe=safeExternalUrl(u); if(safe) html+='<li><span>Site</span><a href="'+escapeAttr(safe)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(u)+'</a></li>';}); html+='</ul></div>'; }
    }
    if(detail.booking && safeExternalUrl(detail.booking.url)) html+='<p><a class="d-link" href="'+escapeAttr(safeExternalUrl(detail.booking.url))+'" target="_blank" rel="noopener noreferrer">Site ou réservation externe<span class="sr-only"> (nouvelle fenêtre)</span></a></p>';
    if(detail.accessibility && detail.accessibility.declared && detail.accessibility.declared.length){ html+='<div class="d-section"><h3>Accessibilité déclarée</h3><div class="d-badges">'+detail.accessibility.declared.map(function(x){return '<span class="d-badge">'+escapeHtml(x)+'</span>';}).join('')+'</div><p class="d-source-line">Déclaration de la source, non vérifiée par HILIA. Une information absente ne signifie ni accessible ni inaccessible.</p></div>'; }
    else { html+='<div class="d-section"><h3>Accessibilité</h3><p class="d-source-line">Non renseignée par la source. Cela ne signifie ni accessible ni inaccessible.</p></div>'; }
    if(detail.hours && detail.hours.length) html+='<div class="d-section d-practical"><h3>Horaires</h3><ul class="d-hours">'+detail.hours.map(function(h){return '<li>'+(h.text?escapeHtml(h.text):escapeHtml((h.days||[]).join(', ')||'Horaires')+(h.opens?' : '+escapeHtml([h.opens,h.closes].filter(Boolean).join('–')):''))+'</li>';}).join('')+'</ul></div>';
    html+='<p class="d-source-line">Source : '+escapeHtml(detail.source?.label||detail.source?.source||'non précisée')+' · '+escapeHtml(detail.licence||'licence non précisée')+'</p>';
    return html;
  }
  function syncEventJsonLd(detail){
    var el=document.getElementById('eventJsonLd');
    if(!detail){ if(el) el.remove(); return; }
    if(!el){ el=document.createElement('script'); el.type='application/ld+json'; el.id='eventJsonLd'; document.head.appendChild(el); }
    var data={'@context':'https://schema.org','@type':'Event',name:detail.name,startDate:detail.dates.start+(detail.dates.startTime?'T'+detail.dates.startTime:''),endDate:detail.dates.end+(detail.dates.endTime?'T'+detail.dates.endTime:''),eventStatus:'https://schema.org/EventScheduled',url:location.href};
    if(detail.description) data.description=detail.description.slice(0,800);
    if(detail.media?.[0]) data.image=mediaProxyUrl(detail.media[0].url);
    if(detail.address||detail.commune) data.location={'@type':'Place',name:detail.name,address:{'@type':'PostalAddress',streetAddress:detail.address||'',postalCode:detail.cp||'',addressLocality:detail.commune||'',addressCountry:'FR'}};
    if(detail.prices && detail.prices.items && detail.prices.items.length){ var item=detail.prices.items.find(function(x){return x.min!=null||x.max!=null||x.price!=null;}); if(item) data.offers={'@type':'Offer',price:item.min??item.max??item.price,priceCurrency:item.currency||'EUR',url:detail.booking?.url||detail.contacts?.websites?.[0]||undefined}; }
    el.textContent=JSON.stringify(data);
  }
  function toggleAgendaEvent(btn){
    var card=btn.closest('[data-agenda-card]'), holder=card?.querySelector('.agenda-event-detail');
    if(!card || !holder) return;
    if(!holder.hidden){ holder.hidden=true; btn.setAttribute('aria-expanded','false'); btn.textContent='Voir le détail'; syncEventJsonLd(null); return; }
    var id=btn.dataset.agendaToggle;
    var show=function(detail){
      if(!detail){ holder.hidden=false; holder.innerHTML='<p class="d-source-line">Le détail de cet événement n’est pas disponible.</p>'; return; }
      holder.innerHTML=renderEventDetail(detail); holder.hidden=false; btn.setAttribute('aria-expanded','true'); btn.textContent='Masquer le détail'; bindMediaFallbacks(holder); syncEventJsonLd(detail);
    };
    if(eventDetailCache[id]){ show(eventDetailCache[id]); return; }
    btn.disabled=true; btn.textContent='Chargement…';
    loadEventDetail(id).then(function(detail){ btn.disabled=false; show(detail); });
  }
  function initAgenda(){
    if(!agendaBound){
      agendaBound=true;
      ['agendaWhere','agendaWhat','agendaFamily','agendaFrom','agendaTo','agendaAccess','agendaFree'].forEach(function(id){
        var el=document.getElementById(id);
        if(el) el.addEventListener(id==='agendaWhere'||id==='agendaWhat'?'input':'change',function(){ agendaLimit=40; renderAgenda(); });
      });
      document.querySelectorAll('[data-agenda-range]').forEach(function(btn){
        btn.addEventListener('click',function(){
          var range=agendaQuickRange(btn.getAttribute('data-agenda-range'));
          var from=document.getElementById('agendaFrom'), to=document.getElementById('agendaTo');
          if(from) from.value=range.from;
          if(to) to.value=range.to;
          agendaLimit=40; renderAgenda();
        });
      });
      var more=document.getElementById('agendaMore'); if(more) more.addEventListener('click',function(){ agendaLimit+=40; renderAgenda(); });
    }
    if(agendaData){ renderAgenda(); return; }
    var status=document.getElementById('agendaStatus'); if(status) status.textContent='Chargement de l’agenda…';
    loadAgendaData().then(function(data){
      if(!data){ renderAgenda(); return; }
      var select=document.getElementById('agendaFamily');
      if(select && select.options.length<=1){
        Object.keys(data.families||{}).sort(function(a,b){return (data.families[b]||0)-(data.families[a]||0)||a.localeCompare(b,'fr');}).forEach(function(f){ var o=document.createElement('option'); o.value=f; o.textContent=f; select.appendChild(o); });
      }
      renderAgenda();
    });
  }

  // ---------- Site pages / lightweight routing ----------
  var currentPage='explore';
  var PAGE_META={
    explore:{title:'HILIA - Rendre le loisir accessible à tous',description:'HILIA référence des lieux de loisirs en France et présente les informations d’accessibilité disponibles pour faciliter les sorties.'},
    about:{title:'À propos - HILIA',description:'Découvrez HILIA, son objectif, ses valeurs et sa démarche autour du loisir accessible.'},
    faq:{title:'FAQ - HILIA',description:'Les réponses aux principales questions sur HILIA, les données d’accessibilité et les avis.'},
    agenda:{title:'Agenda des sorties - HILIA',description:'Concerts, expositions, visites et ateliers : l’agenda des événements avec dates, tarifs et accessibilité déclarée.'},
    profile:{title:'Mon profil - HILIA',description:'Gérez votre profil HILIA et vos contributions.'},
    legal:{title:'Mentions légales - HILIA',description:'Informations légales relatives au site HILIA.'},
    privacy:{title:'Politique de confidentialité - HILIA',description:'Informations relatives à la protection des données personnelles sur HILIA.'},
    cgu:{title:'CGU - HILIA',description:'Conditions générales d’utilisation du site HILIA.'},
    cookies:{title:'Cookies & traceurs - HILIA',description:'Informations sur les cookies et traceurs utilisés par HILIA.'},
    contact:{title:'Contact - HILIA',description:'Contactez HILIA pour une question ou une suggestion.'},
    accessibility:{title:'Déclaration d’accessibilité - HILIA',description:'Engagement, état de conformité et voies de recours en matière d’accessibilité numérique.'},
    sitemap:{title:'Plan du site - HILIA',description:'La liste de toutes les pages du site HILIA.'},
    prestataires:{title:'Référencer mon activité - HILIA',description:'Prestataires de loisirs : renseignez l’accessibilité de votre activité pour être référencé sur HILIA.'}
  };
  // ---------- URL réelles : une page = un chemin, une fiche = /lieu/<slug> ----------
  var PAGE_PATHS={"explore":"/","agenda":"/agenda","about":"/a-propos","faq":"/faq","prestataires":"/prestataires","profile":"/mon-profil","legal":"/mentions-legales","privacy":"/confidentialite","cgu":"/cgu","cookies":"/cookies","contact":"/contact","accessibility":"/accessibilite","sitemap":"/plan-du-site"};
  var PATH_PAGES={}; Object.keys(PAGE_PATHS).forEach(function(k){ PATH_PAGES[PAGE_PATHS[k]]=k; });
  var SITE_ORIGIN='https://www.hilia.fr';
  function pagePath(page){ return PAGE_PATHS[page]||'/'; }
  function pageFromPath(pathname){ var p=String(pathname||'/').replace(/\/index\.html$/,'/').replace(/\/+$/,'')||'/'; return PATH_PAGES[p]||null; }
  function placePath(slug){ return '/lieu/'+encodeURIComponent(slug); }
  function slugFromPath(pathname){ var m=/^\/lieu\/([^/]+)\/?$/.exec(String(pathname||'')); return m?decodeURIComponent(m[1]):null; }
  function ensureMeta(attr,name){ var sel='meta['+attr+'="'+name+'"]', el=document.querySelector(sel); if(!el){ el=document.createElement('meta'); el.setAttribute(attr,name); document.head.appendChild(el); } return el; }
  function setContent(sel,value){ var el=document.querySelector(sel); if(el) el.setAttribute('content',value); }
  function setCanonical(url){ var l=document.querySelector('link[rel="canonical"]'); if(!l){ l=document.createElement('link'); l.setAttribute('rel','canonical'); document.head.appendChild(l); } l.setAttribute('href',url); }
  function removePlaceJsonLd(){ var el=document.getElementById('placeJsonLd'); if(el && el.parentNode) el.parentNode.removeChild(el); }
  function accessibilitySummary(r){
    var parts=[];
    if(isTrue(r[F.ENTREE_PLAIN_PIED])) parts.push('entrée de plain-pied');
    if(isTrue(r[F.ENTREE_RAMPE])) parts.push('rampe d’accès');
    if(isTrue(r[F.ENTREE_ASCENSEUR])) parts.push('ascenseur');
    if(isTrue(r[F.STATIONNEMENT_PMR])) parts.push('stationnement PMR');
    if(isTrue(r[F.SANITAIRES_PMR])) parts.push('sanitaires adaptés');
    if(isTrue(r[F.ACCUEIL_PERSONNEL])) parts.push('accueil par le personnel');
    return parts.length ? parts.join(', ') : 'informations d’accessibilité déclaratives';
  }
  // Métadonnées d’une fiche : titre, description, canonique et données structurées.
  // (Google exécute le JavaScript ; les aperçus sociaux, eux, restent génériques.)
  function syncPlaceMeta(r, slug){
    var name=String(r[F.NOM]||'Lieu');
    var com=COMMUNES[r[F.COM]]||'';
    var cp=r[F.CP]||'';
    var url=SITE_ORIGIN+placePath(slug);
    // Évite « Piscine à Sérent à Sérent » quand le nom contient déjà la commune.
    var place=(com && normalize(name).indexOf(normalize(com))!==-1) ? name : (name+(com?' à '+com:''));
    var title=place+' - accessibilité | HILIA';
    var desc='Accessibilité de '+place+(cp?' ('+cp+')':'')+' : '+accessibilitySummary(r)+'. Stationnement, entrée, accueil et sanitaires sur HILIA.';
    document.title=title;
    setContent('meta[name="description"]',desc);
    setContent('meta[property="og:title"]',title);
    setContent('meta[property="og:description"]',desc);
    setContent('meta[name="twitter:title"]',title);
    setContent('meta[name="twitter:description"]',desc);
    ensureMeta('property','og:url').setAttribute('content',url);
    setCanonical(url);
    ensureMeta('name','robots').setAttribute('content','index,follow');
    // Aperçu de partage propre à la fiche (fonction Vercel /api/og).
    var preview=SITE_ORIGIN+'/api/og?s='+encodeURIComponent(slug);
    setContent('meta[property="og:image"]',preview);
    setContent('meta[name="twitter:image"]',preview);
    var data={'@context':'https://schema.org','@type':'LocalBusiness','name':name,'url':url,'description':desc};
    if(r[F.ADR] || cp || com) data.address={'@type':'PostalAddress',streetAddress:String(r[F.ADR]||''),postalCode:String(cp),addressLocality:com,addressCountry:'FR'};
    var lat=Number(r[F.LAT]), lon=Number(r[F.LON]);
    if(isFinite(lat) && isFinite(lon) && r[F.LAT]!==null && r[F.LON]!==null) data.geo={'@type':'GeoCoordinates',latitude:lat,longitude:lon};
    if(r[F.SITE]){ var site=safeExternalUrl(r[F.SITE]); if(site) data.sameAs=site; }
    var el=document.getElementById('placeJsonLd');
    if(!el){ el=document.createElement('script'); el.type='application/ld+json'; el.id='placeJsonLd'; document.head.appendChild(el); }
    el.textContent=JSON.stringify(data);
  }
  function syncPageMeta(page){
    var meta=PAGE_META[page]||PAGE_META.explore;
    var url=SITE_ORIGIN+pagePath(page);
    document.title=meta.title;
    setContent('meta[name="description"]',meta.description);
    setContent('meta[property="og:title"]',meta.title);
    setContent('meta[property="og:description"]',meta.description);
    setContent('meta[name="twitter:title"]',meta.title);
    setContent('meta[name="twitter:description"]',meta.description);
    ensureMeta('property','og:url').setAttribute('content',url);
    setCanonical(url);
    ensureMeta('name','robots').setAttribute('content', page==='profile' ? 'noindex,follow' : 'index,follow');
    removePlaceJsonLd();
    syncEventJsonLd(null);
  }
  function syncChromeOffset(){ var nav=document.querySelector('.topnav'); var h=nav ? nav.offsetHeight : 96; document.documentElement.style.setProperty('--topnav-height',h+'px'); }
  function setPageActiveButtons(page){ document.querySelectorAll('[data-nav-page]').forEach(function(b){ var active=b.dataset.navPage===page; b.classList.toggle('active',active); if(b.tagName==='A'){ if(active)b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); } }); }
  function navigatePage(page, push){
    page=page||'explore';     if(['explore','agenda','about','faq','prestataires','profile','legal','privacy','cgu','cookies','contact','accessibility','sitemap'].indexOf(page)===-1) page='explore';
    // Depuis une page de contenu, le jeu de données n'est pas chargé : on rejoint
    // l'exploration par une navigation normale plutôt que d'afficher une liste vide.
    if(DEFER_PLACES && page==='explore'){ location.href=pagePath('explore'); return; }
    currentPage=page;
    syncPageMeta(page);
    document.getElementById('explorePage').style.display = page==='explore' ? '' : 'none';
    document.querySelectorAll('.site-page').forEach(function(el){ el.classList.toggle('active', el.dataset.page===page); });
    document.querySelector('.topnav').classList.toggle('secondary-page', page!=='explore');
    document.getElementById('mainTabbar').hidden = page!=='explore';
    setPageActiveButtons(page); syncChromeOffset();
    if(push!==false){ history.pushState({page:page},'',pagePath(page)); }
    closeDetail(); closeDrawer(); window.scrollTo(0,0); document.getElementById('siteMain')?.focus(); announce(PAGE_META[page].title,200);
    if(page==='profile') renderProfilePage();
    if(page==='agenda') initAgenda();
    if(page==='prestataires') initProviderForm();
    if(page==='explore'){
      if(currentTab==='map' && leafletMap) setTimeout(function(){ leafletMap.invalidateSize({pan:false,animate:false}); drawMap(); },80); else renderList();
    }
  }
  document.querySelectorAll('[data-nav-page]').forEach(function(b){ b.addEventListener('click',function(e){e.preventDefault();navigatePage(b.dataset.navPage,true);}); });
  document.querySelectorAll('[data-nav-target]').forEach(function(b){ b.addEventListener('click',function(e){e.preventDefault();navigatePage(b.dataset.navTarget,true);}); });
  document.querySelectorAll('.skip-link').forEach(function(a){ a.addEventListener('click',function(e){
    var id=a.getAttribute('href').slice(1), t=document.getElementById(id); if(!t) return;
    e.preventDefault();
    if(id==='resultsHeading' && currentPage!=='explore') t=document.getElementById('siteMain');
    t.scrollIntoView({block:'start'}); t.focus({preventScroll:true});
  }); });
  function routeFromLocation(){
    var slug=slugFromPath(location.pathname);
    if(slug){
      if(openPlaceFromSlug(slug)) return;
      history.replaceState({page:'explore'},'',pagePath('explore'));
      navigatePage('explore',false); return;
    }
    var page=pageFromPath(location.pathname);
    var h=location.hash||'';
    if(!page){
      if(h.indexOf('#lieu/')===0){ openPlaceFromSlug(decodeURIComponent(h.slice(6))); return; }
      page=h.replace('#','');
    }
    navigatePage(PAGE_PATHS[page] ? page : 'explore', false);
  }
  window.addEventListener('popstate',routeFromLocation);
  window.addEventListener('hashchange',routeFromLocation);
  window.addEventListener('resize',syncChromeOffset);
  syncChromeOffset();

  // ---------- Persistent accessibility preferences ----------
  var SETTINGS_KEY='halia_accessibility_settings_v1';
  var defaultSettings={theme:'light',text:'100',line:false,letter:false,font:false,links:false,motion:false,visuals:false,pointer:false,color:false};
  function loadSettings(){ try{ var v=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null'); return Object.assign({},defaultSettings,v||{}); }catch(e){ return Object.assign({},defaultSettings); } }
  function saveSettings(){ try{ localStorage.setItem(SETTINGS_KEY,JSON.stringify(a11ySettings)); }catch(e){ /* TODO : stockage persistant indisponible */ } }
  var a11ySettings=loadSettings();
  function applySettings(){
    var root=document.documentElement, body=document.body;
    root.setAttribute('data-theme',a11ySettings.theme||'light');
    root.style.fontSize=(parseInt(a11ySettings.text,10)||100)+'%';
    body.classList.toggle('text-spacing-lines',!!a11ySettings.line);
    body.classList.toggle('text-spacing-letters',!!a11ySettings.letter);
    body.classList.toggle('text-spacing-font',!!a11ySettings.font);
    body.classList.toggle('strong-links',!!a11ySettings.links);
    body.classList.toggle('visuals-hidden',!!a11ySettings.visuals);
    body.classList.toggle('large-pointer',!!a11ySettings.pointer);
    body.classList.toggle('color-support',!!a11ySettings.color);
    if(a11ySettings.motion){ root.classList.add('user-reduced-motion'); } else root.classList.remove('user-reduced-motion');
    if(a11ySettings.motion) root.style.scrollBehavior='auto'; else root.style.removeProperty('scroll-behavior');
    document.querySelectorAll('[data-setting]').forEach(function(btn){
      var setting=btn.dataset.setting, val=btn.dataset.value, active=false;
      if(setting==='theme') active=a11ySettings.theme===val;
      else if(setting==='text') active=String(a11ySettings.text)===String(val);
      else if(setting==='motion') active=!!a11ySettings.motion;
      else if(setting==='visuals') active=!!a11ySettings.visuals;
      else if(setting==='pointer') active=!!a11ySettings.pointer;
      else if(setting==='color') active=!!a11ySettings.color;
      else if(setting==='line') active=!!a11ySettings.line;
      else if(setting==='letter') active=!!a11ySettings.letter;
      else if(setting==='font') active=!!a11ySettings.font;
      else if(setting==='links') active=!!a11ySettings.links;
      btn.setAttribute('aria-pressed',active?'true':'false');
    });
  }
  document.querySelectorAll('[data-setting]').forEach(function(btn){ btn.addEventListener('click',function(){
    var k=btn.dataset.setting,v=btn.dataset.value;
    if(k==='theme') a11ySettings.theme=v;
    else if(k==='text') a11ySettings.text=v;
    else if(k==='motion') a11ySettings.motion=!a11ySettings.motion;
    else if(k==='visuals') a11ySettings.visuals=!a11ySettings.visuals;
    else if(k==='pointer') a11ySettings.pointer=!a11ySettings.pointer;
    else if(k==='color') a11ySettings.color=!a11ySettings.color;
    else if(k==='line') a11ySettings.line=!a11ySettings.line;
    else if(k==='letter') a11ySettings.letter=!a11ySettings.letter;
    else if(k==='font') a11ySettings.font=!a11ySettings.font;
    else if(k==='links') a11ySettings.links=!a11ySettings.links;
    saveSettings(); applySettings();
    var st=document.getElementById('settingsStatus'); if(st) st.textContent='Réglage appliqué et mémorisé dans ce navigateur.';
  }); });
  document.getElementById('settingsReset').addEventListener('click',function(){ a11ySettings=Object.assign({},defaultSettings); saveSettings(); applySettings(); var st=document.getElementById('settingsStatus'); if(st) st.textContent='Réglages réinitialisés.'; });
  applySettings();

  // ---------- Communes : chargement asynchrone à la demande ----------
  var communesPromise=null, communesRef=null;
  function loadCommunes(){
    // Le jeu de données des fiches fournit déjà la liste complète des communes :
    // /data/communes.json (200 Ko) n'est téléchargé qu'en dernier recours.
    if(COMMUNES.length>500) return Promise.resolve(COMMUNES);
    if(!communesPromise){
      communesPromise=fetch('/data/communes.json',{cache:'force-cache'})
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(list){
          if(!Array.isArray(list)) throw new Error('format inattendu');
          communesRef=list; return list;
        })
        .catch(function(err){ console.warn('HILIA : liste des communes indisponible', err); communesPromise=null; return []; });
    }
    return communesPromise;
  }
  // Pré-chargement dès que la personne commence à chercher
  var searchBox=document.getElementById('searchInput');
  if(searchBox) searchBox.addEventListener('focus',function(){ loadCommunes(); },{once:true});
  // Suggestions de communes dans les formulaires de contribution (30 max, saisie ≥ 2 lettres)
  document.addEventListener('input',async function(e){
    var el=e.target; if(!el || !el.matches || !el.matches('input[name="commune"]')) return;
    var dl=document.getElementById('communesList'); if(!dl) return;
    var q=normalize(el.value); if(q.length<2){ dl.innerHTML=''; return; }
    var list=await loadCommunes(), out=[];
    for(var i=0;i<list.length && out.length<30;i++){ if(normalize(list[i]).indexOf(q)===0) out.push(list[i]); }
    dl.innerHTML=out.map(function(n){ return '<option value="'+escapeAttr(n)+'"></option>'; }).join('');
  });

  // Password visibility toggle
  var passwordToggle=document.getElementById('profilePasswordToggle'), passwordInput=document.getElementById('profilePassword');
  function setPasswordVisible(show){
    passwordInput.type=show?'text':'password';
    passwordToggle.setAttribute('aria-pressed',show?'true':'false');
    passwordToggle.textContent=show?'Masquer le mot de passe':'Afficher le mot de passe';
  }
  if(passwordToggle && passwordInput){
    passwordToggle.addEventListener('click',function(){ setPasswordVisible(passwordInput.type!=='text'); });
    // Par sécurité, on remasque le mot de passe quand on change de mode (connexion / création) ou après envoi
    document.querySelectorAll('[data-auth-mode]').forEach(function(b){ b.addEventListener('click',function(){ setPasswordVisible(false); }); });
    if(profileForm) profileForm.addEventListener('submit',function(){ setPasswordVisible(false); });
  }

  // ---------- Chargement à la demande sur les pages de contenu ----------
  // Le jeu de données n'y est pas chargé au départ. La première recherche (ou
  // l'ouverture de l'exploration) le télécharge, puis remplit les mêmes index
  // que le démarrage normal : la recherche fonctionne sans recharger la page.
  var placesPromise = null;
  function ensurePlaces(){
    if(placesPromise) return placesPromise;
    if(!DEFER_PLACES) return Promise.resolve(true);
    announce('Chargement des lieux…', 0);
    placesPromise = (async function(){
      var wasDeferred = DEFER_PLACES;
      DEFER_PLACES = false;
      try{
        var loaded = await loadBasePlaces(raw);
        if(!loaded) throw new Error('jeu de données indisponible');
        hydratePlaces();
        if(await loadReviewRatings()) renderRatingOptions();
        return true;
      }catch(err){
        console.warn('Chargement des lieux impossible', err);
        if(wasDeferred){ DEFER_PLACES = true; placesPromise = null; }
        announce('Impossible de charger les lieux. Vérifiez votre connexion puis réessayez.', 0);
        return false;
      }
    })();
    return placesPromise;
  }
  function hydratePlaces(){
    ACTIVITES = raw.activites.slice();
    getCustomActivitiesEarly().forEach(function(a){ if(ACTIVITES.indexOf(a) < 0) ACTIVITES.push(a); });
    COMMUNES = raw.communes || [];
    DATA = raw.data || [];
    cleanLabels();
    DATA = DATA.concat(buildCustomRows());
    for(var qh=0; qh<DATA.length; qh++){
      var rowH = DATA[qh];
      if(rowH && rowH._hiliaQualif && rowH[F.QUALIF] == null) applyQualif(rowH, rowH._hiliaQualif);
    }
    indexPlacesById();
    applySavedEdits();
    // Index de recherche et indice d'accessibilité, comme au démarrage normal.
    buildSearchIndex();
    document.getElementById('statTotal').textContent = DATA.length.toLocaleString('fr-FR');
    document.getElementById('statCommunes').textContent = COMMUNES.length.toLocaleString('fr-FR');
    document.getElementById('statCats').textContent = ACTIVITES.length;
    order = ACTIVITES.map(function(n,idx){ return idx; }).sort(function(a,b){ return actCounts[b]-actCounts[a]; });
    communeCounts = new Int32Array(COMMUNES.length);
    communeOrder = [];
    for(var cc=0; cc<DATA.length; cc++){
      var ci = DATA[cc][F.COM];
      if(typeof ci === 'number' && ci >= 0 && ci < communeCounts.length) communeCounts[ci]++;
    }
    for(var ck=0; ck<COMMUNES.length; ck++){ if(communeCounts[ck] > 0) communeOrder.push(ck); }
    communeOrder.sort(function(a,b){ return communeCounts[b]-communeCounts[a] || COMMUNES[a].localeCompare(COMMUNES[b],'fr'); });
    // Index des points de la carte : construit au démarrage normal, il doit
    // l'être aussi après un chargement à la demande, sinon la carte reste vide.
    validIdx = [];
    markerCache = {};
    for(var vp=0; vp<DATA.length; vp++){ if(rDataHasCoords(DATA[vp])) validIdx.push(vp); }
    renderActivityOptions(); renderCityOptions(); renderTarifHint(); renderRatingOptions();
  }

  // Recherche transmise par /?q=… (saisie faite depuis une page de contenu).
  var bootQuery=new URLSearchParams(location.search).get('q');
  if(bootQuery){ searchInput.value=bootQuery; state.query=bootQuery; }

  // initial
  updateTabIndex();
  refresh();
  initialized = true;
  // Notes des avis : chargées après le premier rendu, pour ne pas retarder la liste.
  (DEFER_PLACES ? Promise.resolve(false) : loadReviewRatings()).then(function(ok){
    renderRatingOptions();
    if(ok && (state.minRating > 0 || state.sort === 'rating')) refresh();
  });
  restoreSupabaseSession();
  var bootSlug=slugFromPath(location.pathname), bootPage=pageFromPath(location.pathname), bootHash=location.hash||'';
  if(bootSlug){
    // Fiche demandée par son URL : elle s’ouvre dès que les données sont là.
    setTimeout(function(){
      if(openPlaceFromSlug(bootSlug)) return;
      history.replaceState({page:'explore'},'',pagePath('explore')); syncPageMeta('explore');
      announce('Cette fiche de lieu n’est plus disponible.',200);
    },0);
  } else if(bootHash.indexOf('#lieu/')===0){
    // Ancien lien partagé (#lieu/…) : on l’ouvre et l’URL est nettoyée par openDetail.
    var legacySlug=decodeURIComponent(bootHash.slice(6));
    setTimeout(function(){
      if(openPlaceFromSlug(legacySlug)) return;
      history.replaceState({page:'explore'},'',pagePath('explore')); syncPageMeta('explore');
    },0);
  } else {
    var hashPage=bootHash.replace('#','');
    var bootTarget=bootPage || (PAGE_PATHS[hashPage] ? hashPage : 'explore');
    if(bootTarget!=='explore') navigatePage(bootTarget,false);
    if(bootTarget!==bootPage || bootHash) history.replaceState({page:bootTarget},'',pagePath(bootTarget));
  }
})();

