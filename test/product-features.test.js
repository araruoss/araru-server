import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSeries, naturalVolume } from '../server/services/productService.js';

test('ordena volumes numericamente, inclusive decimais', () => {
  const values=['10','1.5','2','1'].sort((a,b)=>naturalVolume(a)-naturalVolume(b));
  assert.deepEqual(values,['1','1.5','2','10']);
});

test('detecção conservadora de série registra confiança e fonte', () => {
  assert.deepEqual(detectSeries('Solo Leveling Volume 4'),{name:'Solo Leveling',volume:4,confidence:.72,source:'filename-pattern'});
  assert.equal(detectSeries('Arquitetura limpa'),null);
});
