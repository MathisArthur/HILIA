import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedMediaUrl, isPrivateIp } from '../../../lib/media-policy.js';

const hosts = new Set(['images.example.test', 'medias.tourism-system.com']);

test('les adresses privées, locales et réservées sont refusées', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.4.2', '192.168.1.4', '169.254.1.2', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('le proxy n’accepte que les hôtes explicitement autorisés', () => {
  assert.equal(isAllowedMediaUrl('https://images.example.test/photo.jpg', hosts), true);
  assert.equal(isAllowedMediaUrl('http://medias.tourism-system.com/a/b.jpg', hosts), true);
  assert.equal(isAllowedMediaUrl('https://evil.example.test/photo.jpg', hosts), false);
  assert.equal(isAllowedMediaUrl('https://images.example.test.evil.test/photo.jpg', hosts), false);
  assert.equal(isAllowedMediaUrl('https://user:pass@images.example.test/photo.jpg', hosts), false);
  assert.equal(isAllowedMediaUrl('file:///etc/passwd', hosts), false);
  assert.equal(isAllowedMediaUrl('javascript:alert(1)', hosts), false);
  assert.equal(isAllowedMediaUrl('https://localhost/photo.jpg', hosts), false);
  assert.equal(isAllowedMediaUrl('https://images.example.test:8443/photo.jpg', hosts), false, 'le port explicite ne doit pas contourner la liste');
});
