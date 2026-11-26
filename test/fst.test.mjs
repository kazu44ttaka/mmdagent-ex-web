import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fst, FstSet, parseArgs } from '../src/fst.js';
import { KeyValue } from '../src/bindings.js';

const MAIN = `
0 LOOP:
    <eps> STAGE|images/floor_green.png,images/back_white.png
    <eps> MODEL_ADD|0|gene/Gene.pmd
    MODEL_EVENT_ADD|0  MOTION_ADD|0|base|motions/wait/01_Wait.vmd|FULL|LOOP|ON|OFF
    <eps> CAMERA|0,15.25,0|4.5,0,0|22.4|27.0

LOOP LOOP:
    KEY|1 SYNTH_START|0|mei_voice_normal|こんにちは！よろしくね！

LOOP LOOP:
    KEY|2 SYNTH_START|0|slt_voice_normal|"Hello! My name is gene. How can I help you?"
`;

const msg = (list) => list.map((m) => (m.args ? `${m.type}|${m.args}` : m.type));

test('a block runs its <eps> lines, then waits for the event', () => {
  const fst = new Fst();
  assert.equal(fst.load(MAIN).errors, 0);
  assert.deepEqual(msg(fst.step()), [
    'STAGE|images/floor_green.png,images/back_white.png',
    'MODEL_ADD|0|gene/Gene.pmd',
  ]);
  assert.deepEqual(msg(fst.step('MODEL_EVENT_ADD', '1')), []);
  assert.deepEqual(msg(fst.step('MODEL_EVENT_ADD', '0')), [
    'MOTION_ADD|0|base|motions/wait/01_Wait.vmd|FULL|LOOP|ON|OFF',
    'CAMERA|0,15.25,0|4.5,0,0|22.4|27.0',
  ]);
  assert.equal(fst.current?.label, 'LOOP');
});

test('blocks from the same state are alternatives, quotes are removed', () => {
  const fst = new Fst();
  fst.load(MAIN);
  fst.step();
  fst.step('MODEL_EVENT_ADD', '0');
  assert.deepEqual(msg(fst.step('KEY', '2')), ['SYNTH_START|0|slt_voice_normal|Hello! My name is gene. How can I help you?']);
  assert.deepEqual(msg(fst.step('KEY', '1')), ['SYNTH_START|0|mei_voice_normal|こんにちは！よろしくね！']);
  assert.deepEqual(msg(fst.step('KEY', '3')), []);
});

test('one-line arcs, "+" alternatives, variables and tests', () => {
  const kv = new KeyValue();
  kv.set('Name', 'gene');
  const fst = new Fst({ keyValue: kv });
  fst.load(`
$greet=hello
0 1 <eps> <eps> $n=0
1 2:
    KEY|a  SAY|$greet|\${%Name}  $n=1
    +KEY|b
    $n==1  DONE|$n
2 1 <eps> <eps>
`);
  assert.deepEqual(msg(fst.step()), []);
  assert.equal(fst.vars.get('n'), '0');
  assert.deepEqual(msg(fst.step('KEY', 'a')), ['SAY|hello|gene', 'DONE|1']);
  assert.equal(fst.current?.label, '1');
  // the "+" line repeats the output but has no action of its own, so $n stays 1
  fst.vars.set('n', '0');
  assert.deepEqual(msg(fst.step('KEY', 'b')), ['SAY|hello|gene']);
});

test('the second line of a block waits in a hidden state', () => {
  const fst = new Fst();
  fst.load(`
0 9:
    A  X
    B  Y
`);
  assert.deepEqual(msg(fst.step('B')), []);
  assert.deepEqual(msg(fst.step('A')), ['X']);
  assert.notEqual(fst.current?.label, '9');
  assert.deepEqual(msg(fst.step('B')), ['Y']);
  assert.equal(fst.current?.label, '9');
});

test('an arc argument must be one of the alternatives of the input', () => {
  const fst = new Fst();
  fst.load('0 1 RECOG_EVENT_STOP|こんにちは,やあ OK\n');
  assert.deepEqual(parseArgs('a|b,c'), [['a'], ['b', 'c']]);
  assert.deepEqual(msg(fst.step('RECOG_EVENT_STOP', 'やあ')), []);
  const fst2 = new Fst();
  fst2.load('0 1 RECOG_EVENT_STOP|やあ OK\n');
  assert.deepEqual(msg(fst2.step('RECOG_EVENT_STOP', 'こんにちは,やあ')), ['OK']);
  // different number of "|" arguments never matches
  const fst3 = new Fst();
  fst3.load('0 1 MODEL_EVENT_ADD|0 OK\n');
  assert.deepEqual(msg(fst3.step('MODEL_EVENT_ADD', '0|x')), []);
});

test('@regexp@ inputs set $1..', () => {
  const fst = new Fst();
  fst.load('0 1 @RECOG_EVENT_STOP\\|(.*)です@ ECHO|$1\n');
  assert.deepEqual(msg(fst.step('RECOG_EVENT_STOP', '雨です')), ['ECHO|雨']);
});

test('%INCLUDE and sub FSTs', () => {
  const files = { 'sub.fst': '0 1 <eps> FROM_INCLUDE\n' };
  const fst = new Fst();
  fst.load('%INCLUDE("sub.fst")\n1 2 KEY|x DONE\n', { include: (p) => files[p] ?? null });
  const other = new Fst({ name: 'sub1' });
  other.load('0 0 KEY|x SUB_SAW_X\n');
  const set = new FstSet();
  set.add(fst);
  set.add(other);
  assert.deepEqual(msg(set.start()), ['FROM_INCLUDE']);
  assert.deepEqual(msg(set.input('KEY', 'x')), ['DONE', 'SUB_SAW_X']);
});

test('an <eps> loop is cut off', () => {
  const fst = new Fst();
  fst.load('0 0 <eps> TICK\n');
  assert.equal(fst.step().length, 10000);
});
