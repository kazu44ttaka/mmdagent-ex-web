import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpVfs, fileUrl } from '../src/vfs.js';
import { readLaunchParams, loadFileList } from '../src/launch.js';

/** A fetch that serves `files` (URL → string) and records what was asked. */
function fakeFetch(files) {
  const asked = [];
  const impl = async (url) => {
    asked.push(String(url));
    const body = files[String(url)];
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => null };
    const bytes = new TextEncoder().encode(body);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer, json: async () => JSON.parse(body) };
  };
  return { impl, asked };
}

test('launch parameters: content becomes an absolute folder URL', () => {
  const p = readLaunchParams('?content=/content&mdf=maai_sds/maai_sds_web.mdf&ws=ws://localhost:9001/chat&connect=1',
    'http://127.0.0.1:8010/index.html');
  assert.equal(p.content, 'http://127.0.0.1:8010/content/');
  assert.equal(p.mdf, 'maai_sds/maai_sds_web.mdf');
  assert.equal(p.ws, 'ws://localhost:9001/chat');
  assert.equal(p.connect, true);
  const none = readLaunchParams('', 'http://localhost:8000/');
  assert.deepEqual(none, { content: null, mdf: '', ws: '', connect: false });
});

test('file list: {"files": [...]} or a bare array, next to the content', async () => {
  const { impl, asked } = fakeFetch({
    'http://h/c/files.json': JSON.stringify({ files: ['a/B.pmd', '', 3, 'm.mdf'] }),
    'http://h/d/files.json': JSON.stringify(['x.mdf']),
  });
  assert.deepEqual(await loadFileList('http://h/c/', impl), ['a/B.pmd', 'm.mdf']);
  assert.deepEqual(await loadFileList('http://h/d/', impl), ['x.mdf']);
  assert.equal(asked[0], 'http://h/c/files.json');
  await assert.rejects(loadFileList('http://h/none/', impl), /HTTP 404/);
});

test('HTTP tree: case-insensitive lookup, encoded URLs, fetched on read', async () => {
  const { impl, asked } = fakeFetch({
    'http://h/c/gene/Gene.pmd': 'model',
    'http://h/c/maai_sds/%E3%81%82.fst': 'fst',
  });
  const vfs = createHttpVfs('http://h/c', ['gene/Gene.pmd', 'maai_sds/あ.fst', 'maai_sds\\x.mdf'], impl);
  assert.equal(vfs.size, 3);
  assert.equal(vfs.has('GENE\\gene.pmd'), true);
  assert.equal(vfs.realPath('maai_sds/X.mdf'), 'maai_sds/x.mdf');
  assert.equal(vfs.url('gene/gene.pmd'), 'http://h/c/gene/Gene.pmd');
  assert.equal(vfs.url('none'), null);
  assert.deepEqual(vfs.list(), ['gene/Gene.pmd', 'maai_sds/x.mdf', 'maai_sds/あ.fst']);
  assert.equal(asked.length, 0);
  assert.equal(await vfs.text('maai_sds/あ.fst'), 'fst');
  assert.deepEqual(Array.from(await vfs.bytes('gene/gene.pmd')), Array.from(new TextEncoder().encode('model')));
  assert.equal(await vfs.text('none'), null);
  await assert.rejects(vfs.text('maai_sds/x.mdf'), /HTTP 404/);
});

test('file URLs keep the folder and encode each segment', () => {
  assert.equal(fileUrl('http://h/content/', 'a b/c#d.vmd'), 'http://h/content/a%20b/c%23d.vmd');
  assert.equal(fileUrl('http://h/content/', '../x/./y.png'), 'http://h/content/x/y.png');
});
