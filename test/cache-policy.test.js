import assert from 'node:assert/strict';
import test from 'node:test';
import { coverQuality, imageDimensions } from '../server/services/cacheService.js';

test('classifica qualidade e dimensões de capas sem decodificar imagem inteira',()=>{
  const png=Buffer.alloc(24);png.write('PNG',1);png.writeUInt32BE(600,16);png.writeUInt32BE(900,20);
  assert.deepEqual(imageDimensions(png),{width:600,height:900});
  assert.equal(coverQuality({width:600,height:900,source:'embedded',pipelineVersion:2}),'ok');
  assert.equal(coverQuality({width:100,height:150,source:'embedded',pipelineVersion:2}),'too-small');
  assert.equal(coverQuality({width:1200,height:200,source:'embedded',pipelineVersion:2}),'extreme-ratio');
});
