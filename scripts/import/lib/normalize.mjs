/**
 * Normalisation des enregistrements du paquet, sans aucune invention.
 *
 * Règle centrale : une valeur absente reste null. Un booléen false n'est
 * conservé que s'il est explicitement présent dans la source. Les observations
 * d'accessibilité contradictoires ne sont jamais fusionnées en une conclusion.
 */
import { familyOf } from './categories.mjs';

export const SOURCE_LABELS = {
  hilia: 'HILIA',
  acceslibre: 'Acceslibre',
  datatourisme: 'DATAtourisme',
  datatourisme_csv: 'DATAtourisme (CSV)',
  museofile: 'Muséofile',
  paris_events: 'Que faire à Paris',
};
export const LICENCE_LABELS = {
  existing_internal: 'Données internes HILIA',
  'etalab-2.0': 'Licence Ouverte 2.0',
  'etalab-open-licence': 'Licence Ouverte / Open Licence',
  'ODbL-1.0': 'ODbL 1.0',
};
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g;
const IMAGE_EXT = /\.(avif|gif|jpe?g|png|webp)(?:[?#]|$)/i;
const BAD_CREDIT = /^(non communiqué|non communiquée|inconnu|unknown|non renseigné|sans crédit|n\/a)$/i;

export function tidyText(value) {
  if (value == null) return '';
  return String(value)
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u2014/g, '-');
}

export function cleanName(value) {
  return tidyText(value).replace(/\s+/g, ' ');
}

export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function unique(values) {
  return [...new Set(values.filter((v) => v != null && v !== ''))];
}

export function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function safeWebsite(value) {
  const raw = String(value || '').trim();
  if (!isHttpUrl(raw)) return null;
  const u = new URL(raw);
  u.hash = '';
  return u.href;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function cleanPhone(value) {
  const raw = String(value || '').trim();
  if (!/^[+()\d.\s-]{6,}$/.test(raw)) return null;
  const out = raw.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return out.replace(/\D/g, '').length >= 6 ? out : null;
}

export function dateOnly(value) {
  if (typeof value !== 'string') return null;
  const s = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? s : null;
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function sourceInfo(record, ref) {
  const source = (record.sources || []).find((s) => `${s.source}:${s.source_id}` === ref) || null;
  if (!source) {
    const name = String(ref || '').split(':')[0];
    return {
      ref,
      source: name || null,
      label: SOURCE_LABELS[name] || name || 'Source non précisée',
      licence: null,
      licenceLabel: 'Licence non précisée',
      url: null,
      updatedAt: null,
    };
  }
  return {
    ref,
    source: source.source,
    label: SOURCE_LABELS[source.source] || source.creator || source.source,
    creator: source.creator || null,
    licence: source.licence || null,
    licenceLabel: LICENCE_LABELS[source.licence] || source.licence || 'Licence non précisée',
    url: isHttpUrl(source.source_id) ? source.source_id : null,
    updatedAt: source.source_updated_at || null,
    retrievedAt: source.retrieved_at || null,
  };
}

export function sourceRefsOf(record) {
  return (record.sources || []).map((s) => {
    const info = sourceInfo(record, `${s.source}:${s.source_id}`);
    return { ...info, matchMethod: s.match_method || null };
  });
}

function detailObjects(record) {
  return Object.entries(record.details_by_source || {}).map(([ref, value]) => ({
    ref,
    source: sourceInfo(record, ref),
    value: value && typeof value === 'object' ? value : {},
  }));
}

export function descriptionOf(record) {
  const main = tidyText(record.description);
  if (main) return main.slice(0, 6000);
  let best = '';
  for (const [ref, details] of Object.entries(record.details_by_source || {})) {
    for (const text of asArray(details?.descriptions)) {
      const clean = tidyText(text);
      if (clean.length > best.length) best = clean;
    }
    if (best) break;
  }
  return best.slice(0, 6000);
}

export function categoriesOf(record) {
  return unique(asArray(record.categories).map(cleanName)).slice(0, 8);
}

export function extractContacts(record) {
  const emails = [];
  const phones = [];
  const websites = [];
  const legalNames = [];
  const sources = new Set();

  const visit = (value, ref) => {
    if (value == null) return;
    if (Array.isArray(value)) { value.forEach((v) => visit(v, ref)); return; }
    if (typeof value !== 'object') return;
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'string' || typeof raw === 'number') {
        const v = String(raw).trim();
        if (key === 'schema:email' && validEmail(v)) { emails.push(v); sources.add(ref); }
        else if (key === 'schema:telephone') { const p = cleanPhone(v); if (p) { phones.push(p); sources.add(ref); } }
        else if ((key === 'foaf:homepage' || key === 'schema:url' || key === 'site_internet' || key === 'contact_url') && safeWebsite(v)) {
          websites.push(safeWebsite(v)); sources.add(ref);
        } else if (key === 'schema:legalName') { const n = cleanName(v); if (n) legalNames.push(n); }
      } else if (raw && typeof raw === 'object') visit(raw, ref);
    }
  };

  for (const { ref, value } of detailObjects(record)) {
    const d = value.details && typeof value.details === 'object' ? value.details : value;
    visit(d.hasContact, ref);
    visit(d.hasBookingContact, ref);
    visit(d, ref);
    if (value.site_internet && safeWebsite(value.site_internet)) websites.push(safeWebsite(value.site_internet));
    if (value.contact_url && safeWebsite(value.contact_url)) websites.push(safeWebsite(value.contact_url));
  }
  for (const site of asArray(record.websites)) if (safeWebsite(site)) websites.push(safeWebsite(site));

  return {
    emails: unique(emails).slice(0, 3),
    phones: unique(phones).slice(0, 3),
    websites: unique(websites).slice(0, 3),
    legalNames: unique(legalNames).slice(0, 2),
    sourceRefs: [...sources],
  };
}

function parseDay(value) {
  const raw = String(value || '').split(/[:/]/).pop().replace(/_/g, ' ');
  const map = {
    monday: 'lundi', tuesday: 'mardi', wednesday: 'mercredi', thursday: 'jeudi',
    friday: 'vendredi', saturday: 'samedi', sunday: 'dimanche',
  };
  return map[raw.toLowerCase()] || null;
}

function clock(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

export function extractHours(record, today = todayIso()) {
  const out = [];
  const seen = new Set();
  for (const { ref, source, value } of detailObjects(record)) {
    const d = value.details && typeof value.details === 'object' ? value.details : value;
    const specs = [
      ...asArray(d['location.schema:openingHoursSpecification']),
      ...asArray(d['schema:openingHoursSpecification']),
      ...asArray(d['location.textOpeningHoursSpecification']),
      ...asArray(d['textOpeningHoursSpecification']),
    ];
    for (const spec of specs) {
      if (typeof spec === 'string' && spec.startsWith('data:')) continue;
      if (typeof spec === 'string') {
        const note = tidyText(spec);
        if (!note) continue;
        const key = `text|${note}|${ref}`;
        if (!seen.has(key)) { seen.add(key); out.push({ text: note, sourceRef: ref, source: source.label }); }
        continue;
      }
      if (!spec || typeof spec !== 'object') continue;
      const from = dateOnly(spec['schema:validFrom']) || null;
      const to = dateOnly(spec['schema:validThrough']) || null;
      if (to && to < today) continue; // horaire expiré : ne pas afficher comme actuel
      const days = asArray(spec['schema:dayOfWeek']).map(parseDay).filter(Boolean);
      const opens = clock(spec['schema:opens']);
      const closes = clock(spec['schema:closes']);
      const note = tidyText(spec.additionalInformation || spec['schema:description']);
      if (!days.length && !opens && !closes && !note) continue;
      const item = {
        ...(days.length ? { days: unique(days) } : {}),
        ...(opens ? { opens } : {}),
        ...(closes ? { closes } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(note ? { note } : {}),
        ...(spec['schema:validFrom'] && !from ? { rawFrom: String(spec['schema:validFrom']) } : {}),
        sourceRef: ref,
        source: source.label,
      };
      const key = JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); out.push(item); }
      if (out.length >= 24) return out;
    }
  }
  return out;
}

function priceItemsFrom(offers, ref) {
  const out = [];
  for (const offer of asArray(offers)) {
    if (!offer || typeof offer !== 'object') continue;
    const specs = asArray(offer['schema:priceSpecification'] ?? offer.priceSpecification ?? offer);
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') continue;
      const min = Number.isFinite(Number(spec['schema:minPrice'])) ? Number(spec['schema:minPrice']) : null;
      const max = Number.isFinite(Number(spec['schema:maxPrice'])) ? Number(spec['schema:maxPrice']) : null;
      const price = Number.isFinite(Number(spec['schema:price'])) ? Number(spec['schema:price']) : null;
      if (min == null && max == null && price == null) continue;
      const currency = /^[A-Z]{3}$/.test(String(spec['schema:priceCurrency'] || '')) ? String(spec['schema:priceCurrency']) : null;
      const label = tidyText(spec.name || spec['schema:name'] || spec.additionalInformation || spec['schema:description']);
      const period = spec.appliesOnPeriod && typeof spec.appliesOnPeriod === 'object' ? spec.appliesOnPeriod : null;
      out.push({
        ...(label ? { label } : {}),
        min, max, price, currency,
        ...(period ? { period: tidyText(period.startDate || period['schema:startDate'] || '') + (period.endDate || period['schema:endDate'] ? ' - ' + tidyText(period.endDate || period['schema:endDate'] || '') : '') } : {}),
        sourceRef: ref,
      });
    }
  }
  return out;
}

export function extractPrices(record, today = todayIso()) {
  const items = [];
  let explicitFree = null;
  const refs = new Set();
  for (const { ref, value } of detailObjects(record)) {
    const d = value.details && typeof value.details === 'object' ? value.details : value;
    if (d['schema:isAccessibleForFree'] === true) explicitFree = true;
    if (d['schema:isAccessibleForFree'] === false && explicitFree !== true) explicitFree = false;
    if (!d['schema:offers']) continue;
    const found = priceItemsFrom(d['schema:offers'], ref);
    if (found.length) { refs.add(ref); items.push(...found); }
  }
  const seen = new Set();
  const cleanItems = [];
  for (const item of items) {
    if (item.period && /^\d{4}-\d{2}-\d{2}\s*-\s*\d{4}-\d{2}-\d{2}/.test(item.period)) {
      const end = item.period.split(' - ').pop();
      if (dateOnly(end) && end < today) continue;
    }
    const key = JSON.stringify(item);
    if (!seen.has(key)) { seen.add(key); cleanItems.push(item); }
    if (cleanItems.length >= 12) break;
  }
  const amounts = cleanItems.flatMap((i) => [i.min, i.max, i.price]).filter((v) => Number.isFinite(v));
  const allZero = amounts.length > 0 && amounts.every((v) => v === 0);
  return {
    items: cleanItems,
    free: explicitFree === true || allZero ? true : explicitFree === false ? false : null,
    sourceRefs: [...refs],
  };
}

export function mediaValid(media, today = todayIso()) {
  if (!media || media.rights_status !== 'eligible_with_credit') return false;
  const credit = cleanName(media.credit);
  if (!credit || BAD_CREDIT.test(credit)) return false;
  if (!isHttpUrl(media.url) || !IMAGE_EXT.test(String(media.url))) return false;
  const start = dateOnly(media.rights_start);
  const end = dateOnly(media.rights_end);
  if (start && start > today) return false;
  if (end && end < today) return false;
  return true;
}

export function isPoster(media, name = '') {
  const text = `${media?.url || ''} ${media?.credit || ''} ${JSON.stringify(media?.annotation || '')}`.toLowerCase();
  return /affiche|poster/.test(text) || (name && /affiche|poster/.test(name.toLowerCase()) && /event|expo|concert|spectacle/.test(text));
}

export function extractMedia(record, scope, today = todayIso()) {
  const out = [];
  for (const media of asArray(record.media)) {
    if (scope === 'place') {
      if (media.scope !== 'place') continue;
      if (isPoster(media, record.name)) continue;
    } else if (media.scope !== scope) continue;
    if (!mediaValid(media, today)) continue;
    const source = sourceInfo(record, media.source_ref);
    out.push({
      url: safeWebsite(media.url),
      credit: cleanName(media.credit),
      source: source.label,
      sourceRef: media.source_ref,
      licence: source.licenceLabel,
      ...(media.annotation?.[0]?.['ebucore:title'] && !BAD_CREDIT.test(media.annotation[0]['ebucore:title'])
        ? { title: cleanName(media.annotation[0]['ebucore:title']) }
        : {}),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function accessibilityOf(record) {
  const observations = [];
  let reduced = null;
  const facilities = [];
  for (const { ref, source, value } of detailObjects(record)) {
    const d = value.details && typeof value.details === 'object' ? value.details : value;
    if (typeof d.reducedMobilityAccess === 'boolean') {
      if (reduced == null) reduced = d.reducedMobilityAccess;
      else if (reduced !== d.reducedMobilityAccess) reduced = 'conflict';
    }
    for (const f of asArray(d.isEquippedWith)) {
      if (typeof f === 'string' && f.startsWith('kb:')) facilities.push(f.slice(3));
    }
  }
  // Les observations sont conservées telles quelles, avec leur source. Deux
  // sources contradictoires restent deux observations distinctes.
  for (const obs of asArray(record.accessibility_observations)) {
    const info = sourceInfo(record, obs.source_ref);
    observations.push({
      sourceRef: obs.source_ref,
      source: info.label,
      updatedAt: info.updatedAt,
      scope: obs.scope || null,
      values: obs.values && typeof obs.values === 'object' ? obs.values : {},
    });
  }
  const sourceRefs = unique(observations.map((o) => o.sourceRef)).map((ref) => sourceInfo(record, ref));
  return {
    observations: observations.slice(0, 8),
    reducedMobility: reduced,
    facilities: unique(facilities).slice(0, 8),
    sources: sourceRefs,
    declared: unique([
      ...(reduced === true ? ['mobilité réduite déclarée'] : reduced === false ? ['mobilité réduite : non déclaré par la source'] : reduced === 'conflict' ? ['sources en désaccord sur la mobilité réduite'] : []),
      ...facilities.map((f) => `équipement déclaré : ${f}`),
    ]),
  };
}

function eventPeriodsOf(record, today) {
  const raw = record.schedule?.periods;
  const periods = [];
  const push = (value) => {
    if (!value || typeof value !== 'object') return;
    const start = dateOnly(value.startDate);
    const end = dateOnly(value.endDate) || start;
    if (!start || !end || start > end || end < today) return;
    periods.push({
      start,
      end,
      ...(clock(value.startTime) ? { startTime: clock(value.startTime) } : {}),
      ...(clock(value.endTime) ? { endTime: clock(value.endTime) } : {}),
    });
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (raw && typeof raw === 'object') {
    if (raw.startDate || raw.endDate) push(raw);
    else Object.values(raw).forEach(push);
  }
  // Les périodes sont des occurrences datées, pas une plage de validité. On
  // garde les occurrences à venir (ou en cours) et on déduplique les doublons
  // produits par plusieurs producteurs.
  const seen = new Set();
  return periods
    .filter((p) => {
      const key = p.start + '|' + p.end;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

export function extractEventDates(record, today = todayIso()) {
  const schedule = record.schedule || {};
  const periods = eventPeriodsOf(record, today);
  let start;
  let end;
  let startTime;
  let endTime;
  if (periods.length) {
    // La prochaine occurrence (ou celle en cours) est la date affichée. Toutes
    // les occurrences restent dans le détail pour le filtrage et l'agenda.
    start = periods[0].start;
    end = periods[0].end;
    startTime = periods[0].startTime;
    endTime = periods[0].endTime;
  } else {
    start = dateOnly(schedule.date_min);
    end = dateOnly(schedule.date_max);
    if (!start && !end) return null;
    if (start && end && start > end) return null;
    if (end && end < today) return null;
  }
  const details = Object.values(record.details_by_source || {}).map((d) => d?.details).filter(Boolean);
  const times = details.map((d) => d.takesPlaceAt).filter((v) => v && typeof v === 'object');
  startTime = startTime || clock(times.find((t) => t.startTime)?.startTime);
  endTime = endTime || clock(times.find((t) => t.endTime)?.endTime);
  const shownPeriods = periods.slice(0, 60).map((p) => ({
    start: p.start,
    end: p.end,
    ...(p.startTime ? { startTime: p.startTime } : {}),
  }));
  return {
    start: start || end,
    end: end || start,
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(periods.length ? { occurrence: true } : {}),
    ...(periods.length > 1 ? { periodCount: periods.length, periods: shownPeriods } : {}),
    ...(periods.length > 60 ? { periodsTruncated: true } : {}),
    note: tidyText(schedule.periods && !Array.isArray(schedule.periods) ? schedule.periods.openingDetails || '' : ''),
  };
}

export function bookingUrlOf(record) {
  for (const { value } of detailObjects(record)) {
    const d = value.details && typeof value.details === 'object' ? value.details : value;
    const offers = asArray(d['schema:offers']);
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object') continue;
      for (const key of ['schema:url', 'schema:bookingUrl', 'url']) {
        if (safeWebsite(offer[key])) return { url: safeWebsite(offer[key]), source: 'offre' };
      }
    }
    for (const contact of [...asArray(d.hasBookingContact), ...asArray(d.hasContact)]) {
      if (contact && typeof contact === 'object' && safeWebsite(contact['foaf:homepage'])) {
        return { url: safeWebsite(contact['foaf:homepage']), source: 'contact de réservation' };
      }
    }
  }
  return null;
}

export function extractAccessibility(record) {
  return accessibilityOf(record);
}

function buildPlaceDetailFor(record, id, today) {
  const description = descriptionOf(record);
  const categories = categoriesOf(record);
  const media = extractMedia(record, 'place', today);
  const hours = extractHours(record, today);
  const prices = extractPrices(record, today);
  const contacts = extractContacts(record);
  const accessibility = accessibilityOf(record);
  const descriptionSource = record.description_source ? sourceInfo(record, record.description_source) : null;
  const hasSomething = description || media.length || hours.length || prices.items.length || contacts.emails.length || contacts.phones.length || contacts.websites.length || categories.length > 1 || accessibility.observations.length || accessibility.sources.length;
  if (!hasSomething) return null;
  return {
    id: String(id),
    ...(description ? { description } : {}),
    ...(descriptionSource ? { descriptionSource } : {}),
    ...(categories.length ? { categories: categories.map((name) => ({ name, family: familyOf(name) })) } : {}),
    ...(media.length ? { media } : {}),
    ...(hours.length ? { hours } : {}),
    ...(prices.items.length ? { prices } : {}),
    ...((contacts.emails.length || contacts.phones.length || contacts.websites.length) ? { contacts } : {}),
    // Le détail conserve les valeurs et les sources, y compris les observations
    // contradictoires. `_unknown` est explicite : aucune observation ne doit
    // devenir une affirmation d'accessibilité.
    accessibility: {
      ...(accessibility.sources.length ? { sources: accessibility.sources } : {}),
      ...(accessibility.observations.length ? { observations: accessibility.observations } : {}),
      ...(accessibility.declared.length ? { declared: accessibility.declared } : {}),
      ...(accessibility.reducedMobility != null ? { reducedMobility: accessibility.reducedMobility } : {}),
      ...(accessibility.facilities.length ? { facilities: accessibility.facilities } : {}),
      ...(accessibility.observations.length ? { observationCount: accessibility.observations.length } : {}),
      _unknown: !accessibility.observations.length && !accessibility.declared.length,
    },
    sourceRefs: sourceRefsOf(record).map((s) => ({ label: s.label, licence: s.licenceLabel, updatedAt: s.updatedAt, url: s.url })),
  };
}

export function buildPlaceDetail(record, snapshotIds, today = todayIso()) {
  if (record.kind !== 'place' || !record.existing_hilia_id || (snapshotIds && !snapshotIds.has(String(record.existing_hilia_id)))) return null;
  return buildPlaceDetailFor(record, record.existing_hilia_id, today);
}

/** Détail d'un nouveau lieu, indexé par l'identifiant public qui sera créé à l'approbation. */
export function buildStagedPlaceDetail(record, placeId, today = todayIso()) {
  if (record.kind !== 'place' || record.existing_hilia_id || !placeId) return null;
  return buildPlaceDetailFor(record, placeId, today);
}

export function buildEventDetail(record, today = todayIso()) {
  if (record.kind !== 'event' || record.publication_status !== 'candidate_event') return null;
  const dates = extractEventDates(record);
  if (!dates || dates.end < today) return null;
  const name = cleanName(record.name);
  if (!name) return null;
  const description = descriptionOf(record);
  const categories = categoriesOf(record);
  const media = extractMedia(record, 'event', today);
  const prices = extractPrices(record, today);
  const contacts = extractContacts(record);
  const hours = extractHours(record, today);
  const accessibility = accessibilityOf(record);
  const booking = bookingUrlOf(record);
  const mainSource = sourceInfo(record, record.description_source || record.sources?.[0] && `${record.sources[0].source}:${record.sources[0].source_id}`);
  return {
    id: record.id,
    name,
    ...(record.commune ? { commune: cleanName(record.commune) } : {}),
    ...(record.postal_code ? { cp: String(record.postal_code) } : {}),
    ...(record.address ? { address: cleanName(record.address) } : {}),
    ...(Number.isFinite(record.coordinates?.latitude) ? { lat: record.coordinates.latitude } : {}),
    ...(Number.isFinite(record.coordinates?.longitude) ? { lon: record.coordinates.longitude } : {}),
    dates,
    ...(description ? { description } : {}),
    ...(categories.length ? { categories: categories.map((cat) => ({ name: cat, family: familyOf(cat) })) } : {}),
    ...(media.length ? { media } : {}),
    ...(prices.items.length ? { prices } : {}),
    ...((contacts.emails.length || contacts.phones.length || contacts.websites.length) ? { contacts } : {}),
    ...(hours.length ? { hours } : {}),
    ...(accessibility.declared.length ? { accessibility: { declared: accessibility.declared, sources: accessibility.sources } } : {}),
    ...(booking ? { booking } : {}),
    source: mainSource,
    licence: mainSource.licenceLabel,
    licencePartition: mainSource.source === 'paris_events' ? 'paris_odbl' : mainSource.licence,
    sourceRefs: sourceRefsOf(record).map((s) => ({ label: s.label, licence: s.licenceLabel, updatedAt: s.updatedAt, url: s.url })),
  };
}

export function reviewStatusOf(record) {
  switch (record.publication_status) {
    case 'existing_preserved': return 'existing_public_preserved';
    case 'candidate_declared_accessibility': return 'accessibility_review';
    case 'review_accessibility': return 'accessibility_review';
    case 'review_duplicate': return 'duplicate_review';
    case 'candidate_event': return 'event_review';
    case 'review_dates': return 'dates_review';
    default: return 'unclassified';
  }
}

export function eventIndexEntry(detail) {
  const categories = detail.categories || [];
  return {
    id: detail.id,
    name: detail.name,
    ...(detail.commune ? { commune: detail.commune } : {}),
    ...(detail.cp ? { cp: detail.cp } : {}),
    ...(detail.address ? { address: detail.address } : {}),
    start: detail.dates.start,
    end: detail.dates.end,
    ...(detail.dates.periodCount ? { periodCount: detail.dates.periodCount } : {}),
    ...(detail.dates.periods ? { periods: detail.dates.periods.map((p) => ({ start: p.start, end: p.end })) } : {}),
    ...(detail.dates.startTime ? { time: detail.dates.startTime } : {}),
    ...(detail.prices ? { free: detail.prices.free } : {}),
    ...(categories.length ? { family: categories[0].family, categories: categories.map((c) => c.name) } : {}),
    ...(detail.media?.[0] ? { thumb: detail.media[0].url, thumbCredit: detail.media[0].credit } : {}),
    ...(detail.source ? { source: detail.source.label } : {}),
    ...(detail.licence ? { licence: detail.licence } : {}),
    // « unknown » est explicite : le filtre et la carte distinguent une absence
    // d'information d'une accessibilité affirmative.
    accessibilityStatus: detail.accessibility?.declared?.length ? 'declared' : 'unknown',
  };
}
