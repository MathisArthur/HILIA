import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const events = JSON.parse(await readFile(new URL('../../../data/events.json', import.meta.url), 'utf8'));
const exclusions = JSON.parse(await readFile(new URL('../../../data/place-exclusions.json', import.meta.url), 'utf8'));

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function periodsOf(event) {
  return event.periods?.length ? event.periods : [{ start: event.start, end: event.end }];
}

function futurePeriods(event, today = todayLocal()) {
  return periodsOf(event)
    .filter((p) => p && (p.start || p.end))
    .map((p) => ({ start: p.start || p.end, end: p.end || p.start }))
    .filter((p) => p.end >= today)
    .sort((a, b) => a.start.localeCompare(b.start));
}

test('le fichier publié ne contient aucun événement entièrement terminé', () => {
  const today = todayLocal();
  const expired = events.events.filter((event) => futurePeriods(event, today).length === 0);
  assert.equal(expired.length, 0);
  assert.ok(events.events.every((event) => event.accessibilityStatus === 'declared' || event.accessibilityStatus === 'unknown'));
});

test('un événement terminé est exclu de la fenêtre à venir', () => {
  assert.equal(futurePeriods({ start: '2026-11-13', end: '2026-11-14' }, '2026-11-16').length, 0);
});

test('un événement en cours reste visible et indique sa fin', () => {
  const event = { start: '2026-11-10', end: '2026-11-20' };
  const future = futurePeriods(event, '2026-11-16');
  assert.equal(future.length, 1);
  assert.equal(future[0].end, '2026-11-20');
});

test('un événement qui commence aujourd’hui reste visible', () => {
  const event = { start: '2026-11-16', end: '2026-11-16' };
  assert.equal(futurePeriods(event, '2026-11-16').length, 1);
});

test('plusieurs occurrences : la prochaine date est la première occurrence future', () => {
  const event = {
    start: '2026-11-10',
    end: '2026-11-10',
    periods: [
      { start: '2026-11-10', end: '2026-11-10' },
      { start: '2026-11-20', end: '2026-11-20' },
      { start: '2026-12-01', end: '2026-12-01' },
    ],
  };
  const future = futurePeriods(event, '2026-11-16');
  assert.deepEqual(future.map((p) => p.start), ['2026-11-20', '2026-12-01']);
});

test('la fiche manifestement incohérente est tracée et absente des données publiées', async () => {
  const places = JSON.parse(await readFile(new URL('../../../data/places.json', import.meta.url), 'utf8'));
  const excluded = exclusions.entries.map((entry) => String(entry.id));
  assert.ok(excluded.includes('29088'));
  assert.equal(places.rows.some((row) => String(row[0]) === '29088'), false);
  assert.equal(places.activites.some((activity) => String(activity).includes('\uFFFD')), false);
});
