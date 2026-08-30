import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRegistryIntegrity, settingsRegistry } from '../server/services/settingsRegistry.js';

test('security settings registry is valid and has supported runtime controls', () => {
  assert.equal(assertRegistryIntegrity(), true);
  assert.equal(settingsRegistry['security.authentication.minPasswordLength'].runtime, true);
  assert.equal(settingsRegistry['security.sessions.sessionSeconds'].restartRequired, true);
  assert.equal(settingsRegistry['security.sessions.idleTimeoutSeconds'].supported, false);
});
