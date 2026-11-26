import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, normalizePath, joinPath, decodeText } from '../src/vfs.js';
import { parseMdf, websocketUrlFromMdf } from '../src/mdf.js';
import { parseMaterialCsv, parseMessageLines, splitCsvRow } from '../src/modelext.js';
import { parseShapeMap } from '../src/shapemap.js';

test('paths: separators, dots, and case-insensitive lookup', () => {
  assert.equal(normalizePath('a\\b/./c/../d'), 'a/b/d');
  assert.equal(joinPath('example/example_websocket', '../gene/gene.pmd'), 'example/gene/gene.pmd');
  const vfs = createVfs([{ path: 'example/gene/Gene.pmd', file: new Blob(['x']) }]);
  assert.equal(vfs.has('EXAMPLE\\gene\\gene.pmd'), true);
  assert.equal(vfs.realPath('example/gene/gene.pmd'), 'example/gene/Gene.pmd');
  assert.equal(vfs.has('example/gene/none.pmd'), false);
});

test('text is UTF-8, or Shift_JIS when it is not valid UTF-8', () => {
  assert.equal(decodeText(new TextEncoder().encode('﻿こんにちは')), 'こんにちは');
  // "あ" in Shift_JIS
  assert.equal(decodeText(new Uint8Array([0x82, 0xa0])), 'あ');
});

test('mdf settings and the WebSocket address Plugin_Remote would use', () => {
  const mdf = parseMdf('# comment\nPlugin_Remote_Websocket_Host=localhost\r\nPlugin_Remote_Websocket_Port=9001\nPlugin_Remote_Websocket_Directory=/chat');
  assert.equal(websocketUrlFromMdf(mdf), 'ws://localhost:9001/chat');
  assert.equal(websocketUrlFromMdf(new Map()), 'ws://localhost:80/');
});

test('material opacities from the Material rows of a model CSV', () => {
  const csv = 'PmdModel,a\nVertex,0,1\nMaterial,"髪",1,1,1,1,0.5,x\nMaterial,"怒り",1,1,1,1,0,x\nFace,0\n';
  const bytes = new TextEncoder().encode(csv);
  assert.deepEqual(parseMaterialCsv(bytes), [{ name: '髪', opacity: 0.5 }, { name: '怒り', opacity: 0 }]);
  assert.deepEqual(splitCsvRow('a,"b,c",d'), ['a', 'b,c', 'd']);
});

test('.loadmessage lines and .shapemap actions', () => {
  assert.deepEqual(parseMessageLines('MENU|ADD|Gene\n\n# x\nKEY'), [['MENU', 'ADD|Gene'], ['KEY', '']]);
  const map = parseShapeMap('LIP_A あ\nNOLIP え,ワ\nACT1  motion/01_happy.vmd\nEXMORPH_smile 笑い 0.5\n');
  assert.equal(map.lip.get('A')[0].morph, 'あ');
  assert.deepEqual(map.nolip, ['え', 'ワ']);
  assert.equal(map.acts.get('ACT1'), 'motion/01_happy.vmd');
  assert.equal(map.exmorph.get('EXMORPH_smile')[0].coef, 0.5);
});
