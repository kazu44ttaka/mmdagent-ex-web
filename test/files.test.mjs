import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVfs, normalizePath, joinPath, decodeText } from '../src/vfs.js';
import { parseMdf, websocketUrlFromMdf } from '../src/mdf.js';
import { parseModelCsv, parseMessageLines, splitCsvRow } from '../src/modelext.js';
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

test('model CSV: Material rows (old and recent PMXEditor columns) and vertex edge rates', () => {
  const old = [
    'PmdModel,a',
    'Vertex,0,1,2,3,0,1,0,0.5,0.1,0.2',
    'Vertex,1,1,2,3,0,1,0,1',
    'Material,"髪","",1,1,1,0.5,0,0,0,5,0.7,0.7,0.7,1,1,0,0,1,0.45,0.4,0.4,0.4,1,"tex/hair.png","",0',
    'Material,"怒り","",1,1,1,0,0,0,0,5,0.7,0.7,0.7,0,0,0,0,0,1,0,0,0,1,"","",0',
    'Face,0',
  ].join('\r\n');
  const a = parseModelCsv(new TextEncoder().encode(old));
  assert.deepEqual(a.vertexEdge, [[0, 0.5], [1, 1]]);
  assert.equal(a.materials.length, 2);
  assert.deepEqual(
    { ...a.materials[0] },
    { name: '髪', alpha: 0.5, face: true, shadow: true, shadowMapDrop: false, shadowMapRender: false, edge: true, edgeWidth: 0.45, edgeColor: [0.4, 0.4, 0.4, 1], tex: 'tex/hair.png', sphere: null, sphereMode: 0 },
  );
  assert.equal(a.materials[1].alpha, 0);
  // a recent PMXEditor adds vertex colour and draw mode, moving the edge columns by 2
  const header = ';Material,' + Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
  const recent = [header, 'Material,"顔","",1,1,1,1,0,0,0,5,0.75,0.75,0.75,0,1,1,1,0,0,1,0.45,0.4,0.4,0.4,1,"tex/face.png","",0,"",""', ''].join('\n');
  const b = parseModelCsv(new TextEncoder().encode(recent)).materials[0];
  assert.equal(b.edge, true);
  assert.equal(b.edgeWidth, 0.45);
  assert.deepEqual(b.edgeColor, [0.4, 0.4, 0.4, 1]);
  assert.equal(b.tex, 'tex/face.png');
  assert.equal(b.face, false);
  assert.equal(b.shadow, true);
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
