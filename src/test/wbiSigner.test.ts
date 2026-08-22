import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWbiKey, signWbiParams } from '../wbiSigner';

test('extractWbiKey follows the Bilibili WBI mixin table', () => {
  const key = extractWbiKey(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  );

  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
});

test('signWbiParams produces the verified getDanmuInfo signature', () => {
  const params = signWbiParams(
    { id: 6, type: 0 },
    'ea1db124af3c7062474693fa704f4ff8',
    1_787_206_932_000
  );

  assert.equal(params.toString(), 'id=6&type=0&wts=1787206932&w_rid=a28fd4cf11ef6c02936444215662cedd');
});

test('signWbiParams sorts keys and removes forbidden characters', () => {
  const params = signWbiParams({ z: "a!b(c)", a: 'first' }, 'key', 1_000);
  assert.equal(params.get('z'), 'abc');
  assert.equal(params.get('a'), 'first');
  assert.equal(params.get('wts'), '1');
  assert.deepEqual([...params.keys()], ['a', 'wts', 'z', 'w_rid']);
});
