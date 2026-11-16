/**
 * Politique de publication des candidats.
 *
 * Aucun nouveau lieu, activité ou itinéraire n'est publié automatiquement.
 * Les enrichissements d'une fiche déjà publique peuvent l'être (l'identité
 * publique existe déjà), mais un nouveau contenu doit passer par une décision
 * d'administration, seule ou par lot.
 *
 * Un niveau « batch » signifie que la décision peut être prise en lot après
 * contrôle des motifs affichés. Un niveau « manual » exige une vérification
 * individuelle (identité, doublon, coordonnées, source ou surface publique).
 * L'absence d'accessibilité n'est jamais un motif d'exclusion : elle est
 * conservée comme information inconnue.
 */
import { familyOf } from './categories.mjs';

const MANUAL_CODES = new Set([
  'missing_id',
  'missing_name',
  'missing_source',
  'missing_location',
  'invalid_coordinates',
  'duplicate_review',
  'public_surface_missing',
]);

function add(reasons, code, label) {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, label });
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function categoryNames(record) {
  return (record.categories || [])
    .map((category) => typeof category === 'string' ? category : category?.name)
    .filter(Boolean);
}

export function assessCandidate(record, today = new Date().toISOString().slice(0, 10)) {
  const reasons = [];
  const kind = record.kind;
  const status = record.publication_status || '';

  if (!record.id) add(reasons, 'missing_id', 'Identifiant source absent');
  if (!record.name) add(reasons, 'missing_name', 'Nom absent');
  if (!Array.isArray(record.sources) || !record.sources.length) add(reasons, 'missing_source', 'Source absente');

  if (kind === 'place') {
    const hasCoordinates = validCoordinate(Number(record.coordinates?.latitude), Number(record.coordinates?.longitude));
    const hasAddress = Boolean(record.address || record.commune || record.postal_code);
    if (!hasCoordinates && !hasAddress) add(reasons, 'missing_location', 'Localisation absente');
    if ((record.coordinates?.latitude != null || record.coordinates?.longitude != null) && !hasCoordinates) {
      add(reasons, 'invalid_coordinates', 'Coordonnées hors limites');
    }
    if (status === 'review_duplicate' || (Array.isArray(record.match_candidates) && record.match_candidates.length)) {
      add(reasons, 'duplicate_review', 'Rapprochement à vérifier');
    }
    const categories = categoryNames(record);
    if (!categories.length) add(reasons, 'category_missing', 'Catégorie absente');
    if (categories.some((name) => familyOf(name) === 'Autres loisirs')) {
      add(reasons, 'category_review', 'Catégorie générique ou à confirmer');
    }
    if (status === 'review_accessibility') {
      add(reasons, 'accessibility_unknown', 'Accessibilité non renseignée');
    } else if (status === 'candidate_declared_accessibility') {
      add(reasons, 'accessibility_declared', 'Accessibilité déclarée, non certifiée');
    }
  }

  if (kind === 'activity') add(reasons, 'public_surface_missing', 'Aucune fiche activité publique active');
  if (kind === 'route') add(reasons, 'public_surface_missing', 'Aucune fiche itinéraire publique active');

  // Une date d'événement explicitement absente interdit une publication
  // automatique. Les dates en revue restent également manuelles.
  if (kind === 'event') {
    if (status === 'review_dates') add(reasons, 'dates_review', 'Calendrier à vérifier');
    if (!record.schedule?.date_min && !record.schedule?.periods) add(reasons, 'missing_dates', 'Dates absentes');
  }

  const manual = reasons.some((reason) => MANUAL_CODES.has(reason.code));
  return {
    // Aucun nouvel objet n'est auto-publié. Seuls les enrichissements de fiches
    // existantes le sont (l'identité publique est déjà approuvée).
    autoPublishable: false,
    reviewLevel: manual ? 'manual' : 'batch',
    reasons,
    accessibility: status === 'review_accessibility' ? 'unknown' : status === 'candidate_declared_accessibility' ? 'declared' : 'unknown',
    publicAfterApproval: kind === 'place',
    reviewedAt: today,
  };
}

export function reviewLevelOf(record) {
  return assessCandidate(record).reviewLevel;
}
