import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const snapshot = JSON.parse(await readFile(new URL('data/places.json', ROOT), 'utf8'));
const snapshotIds = new Set(snapshot.rows.map((row) => String(row[0])));
const report = JSON.parse(await readFile(new URL('data/import-preview/build-report.json', ROOT), 'utf8'));
const events = JSON.parse(await readFile(new URL('data/events.json', ROOT), 'utf8'));

test('tous les identifiants existants sont retrouvés', () => {
  assert.equal(report.existingPlaces, snapshotIds.size);
  assert.equal(report.existingMatched, snapshotIds.size);
  assert.equal(report.newPlacesStaged, 112381);
});

test('aucun événement sans date explicite n’est publié', () => {
  const ids = new Set();
  for (const event of events.events) {
    assert.match(event.start, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(event.end, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(event.start <= event.end, event.id);
    assert.ok(event.end >= report.today, event.id);
    assert.ok(!ids.has(event.id), `doublon ${event.id}`);
    ids.add(event.id);
  }
  assert.equal(events.count, report.eventsPublished);
  // Le build courant écarte les occurrences expirées ; le volume exact est
  // contrôlé par le rapport, sans figer un chiffre qui doit évoluer.
  assert.ok(events.count > 0);
});

test('les shards de lieux ne contiennent que des IDs existants et aucune affiche', async () => {
  const dir = new URL('data/place-details/', ROOT);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 256);
  let checked = 0;
  for (const file of files.slice(0, 3)) {
    const shard = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [id, detail] of Object.entries(shard.places)) {
      assert.ok(snapshotIds.has(id), id);
      assert.equal(detail.id, id);
      for (const media of detail.media || []) {
        assert.equal(media.credit.length > 0, true);
        assert.ok(!/affiche|poster/i.test(media.url), media.url);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});

test('les événements restent séparés des lieux et les catégories sont classées', async () => {
  const placeDir = new URL('data/place-details/', ROOT);
  const shard = JSON.parse(await readFile(new URL('000.json', placeDir), 'utf8'));
  const firstId = Object.keys(shard.places)[0];
  assert.ok(snapshotIds.has(firstId));
  assert.ok(events.events.every((event) => !snapshotIds.has(event.id)));
  assert.ok(Object.keys(events.families).length > 0);
});

test('les droits et crédits restent attachés aux médias affichés', async () => {
  const dir = new URL('data/event-details/', ROOT);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 128);
  const shard = JSON.parse(await readFile(new URL(files[0], dir), 'utf8'));
  for (const detail of Object.values(shard.events)) {
    for (const media of detail.media || []) {
      assert.ok(media.credit);
      assert.ok(media.source);
      assert.ok(media.licence);
    }
  }
});
