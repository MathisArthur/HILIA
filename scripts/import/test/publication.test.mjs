import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCandidate } from '../lib/publication.mjs';

const base = {
  id: 'ext:test',
  kind: 'place',
  name: 'Lieu test',
  address: '1 rue de Test',
  postal_code: '75001',
  commune: 'Paris',
  coordinates: { latitude: 48.86, longitude: 2.35 },
  sources: [{ source: 'datatourisme', source_id: 'x', licence: 'etalab-open-licence' }],
  categories: ['Musée'],
  publication_status: 'review_accessibility',
};

test('un nouveau lieu sans accessibilité reste publiable en lot, mais avec un motif explicite', () => {
  const assessment = assessCandidate(base, '2026-11-13');
  assert.equal(assessment.autoPublishable, false);
  assert.equal(assessment.reviewLevel, 'batch');
  assert.ok(assessment.reasons.some((reason) => reason.code === 'accessibility_unknown'));
  assert.equal(assessment.publicAfterApproval, true);
});

test('un doublon ou une localisation absente exige une revue individuelle', () => {
  assert.equal(assessCandidate({ ...base, match_candidates: ['hilia:1'] }, '2026-11-13').reviewLevel, 'manual');
  assert.equal(assessCandidate({ ...base, address: null, postal_code: null, commune: null, coordinates: null }, '2026-11-13').reviewLevel, 'manual');
  assert.equal(assessCandidate({ ...base, sources: [] }, '2026-11-13').reviewLevel, 'manual');
});

test('une activité ou un itinéraire reste préparé sans publication publique', () => {
  const activity = assessCandidate({ ...base, kind: 'activity', categories: ['Atelier'] }, '2026-11-13');
  assert.equal(activity.reviewLevel, 'manual');
  assert.equal(activity.publicAfterApproval, false);
  assert.ok(activity.reasons.some((reason) => reason.code === 'public_surface_missing'));
});

test('une catégorie générique est signalée mais ne bloque pas le lot', () => {
  const assessment = assessCandidate({ ...base, categories: ['Loisirs'] }, '2026-11-13');
  assert.equal(assessment.reviewLevel, 'batch');
  assert.ok(assessment.reasons.some((reason) => reason.code === 'category_review'));
});
