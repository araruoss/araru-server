import { createHmac, timingSafeEqual } from 'node:crypto';

function assinatura(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function compararSeguro(a = '', b = '') {
  const primeiro = Buffer.from(String(a));
  const segundo = Buffer.from(String(b));
  return primeiro.length === segundo.length && timingSafeEqual(primeiro, segundo);
}

export function criarTokenAcesso(secret, ttlSeconds = 86400) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds) })).toString('base64url');
  return `${payload}.${assinatura(payload, secret)}`;
}

export function validarTokenAcesso(token, secret) {
  if (!token || !secret) return false;
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature || !compararSeguro(signature, assinatura(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function validarSegredoAcesso(recebido, esperado) {
  return Boolean(esperado) && compararSeguro(recebido, esperado);
}
