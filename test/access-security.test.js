import assert from 'node:assert/strict';
import test from 'node:test';
import { criarTokenAcesso, validarSegredoAcesso, validarTokenAcesso } from '../server/services/accessService.js';

test('token de acesso é assinado, expira e rejeita adulteração', () => {
  const secret = 'segredo-de-teste';
  const token = criarTokenAcesso(secret, 120);
  assert.equal(validarTokenAcesso(token, secret), true);
  assert.equal(validarTokenAcesso(`${token}x`, secret), false);
  assert.equal(validarTokenAcesso(token, 'outro-segredo'), false);
  assert.equal(validarSegredoAcesso(secret, secret), true);
  assert.equal(validarSegredoAcesso('incorreto', secret), false);
});
