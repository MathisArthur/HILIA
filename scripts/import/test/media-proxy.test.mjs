import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../../../app.js', import.meta.url), 'utf8');
const proxy = await readFile(new URL('../../../api/media.js', import.meta.url), 'utf8');

// Le proxy attend le paramètre « u », pas « url ». Ce test cible le 400 observé
// pendant un contrôle manuel qui appelait /api/media?url=….
test('le client et le proxy partagent le paramètre média u', () => {
  assert.match(app, /\/api\/media\?u=/);
  assert.match(proxy, /searchParams\.get\('u'\)/);
  assert.doesNotMatch(app, /\/api\/media\?url=/);
});
