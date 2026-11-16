import assert from 'node:assert/strict';
import test from 'node:test';
import { supabaseHeaders } from '../../../lib/supabase-key.js';

test('une clé publishable reste dans apikey, sans Bearer', () => {
  const headers = supabaseHeaders('sb_publishable_test_value');
  assert.equal(headers.apikey, 'sb_publishable_test_value');
  assert.equal(headers.Authorization, undefined);
});

test('une ancienne clé JWT garde Authorization: Bearer', () => {
  const headers = supabaseHeaders('eyJhbGciOiJIUzI1NiJ9.test.signature');
  assert.equal(headers.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.test.signature');
});
