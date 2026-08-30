import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ARARU_MASTER_KEY = 'test-master-key-that-is-not-stored-in-postgres';
const { encrypt, decrypt } = await import('../server/services/secretEncryptionService.js');

test('provider credentials use authenticated encryption', () => {
  const envelope = encrypt({ token: 'secret' }, 'connection:local');
  assert.notEqual(envelope.ciphertext, 'secret');
  assert.deepEqual(decrypt(envelope, 'connection:local'), { token: 'secret' });
  assert.throws(() => decrypt(envelope, 'connection:other'));
  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('a') ? 'b' : 'a'}` };
  assert.throws(() => decrypt(tampered, 'connection:local'));
});
