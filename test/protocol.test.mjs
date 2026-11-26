import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteStream, formatMessage } from '../src/protocol.js';

function collect() {
  const got = { messages: [], avatar: [], sound: [], breaks: 0, modes: [] };
  const stream = createRemoteStream({
    onMessage: (t, a) => got.messages.push(a ? `${t}|${a}` : t),
    onAvatar: (l) => got.avatar.push(l),
    onSound: (pcm) => got.sound.push(Array.from(pcm)),
    onSoundBreak: () => { got.breaks += 1; },
    onSoundMode: (m) => got.modes.push(m),
  });
  return { stream, got };
}

/** "SND" + 4 digits + PCM16 LE */
function sndChunk(samples) {
  const pcm = new Int16Array(samples);
  const head = new TextEncoder().encode(`SND${String(pcm.byteLength).padStart(4, '0')}`);
  const out = new Uint8Array(head.length + pcm.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(pcm.buffer), head.length);
  return out;
}

test('text lines: messages, __AV lines and __AV_MESSAGE', () => {
  const { stream, got } = collect();
  stream.pushText('__AV_START\n__AV_SETMODEL,gene\nKEYVALUE_SET|MaAI_HeadPitch|0.25\n');
  stream.pushText('__AV_MESSAGE,MOTION_ADD|gene|a|b.vmd\r\nMODEL_BINDFACE|MaAI_Blink|0|1|gene|まばたき|0|1\n');
  assert.deepEqual(got.avatar, ['__AV_START', '__AV_SETMODEL,gene']);
  assert.deepEqual(got.messages, [
    'KEYVALUE_SET|MaAI_HeadPitch|0.25',
    'MOTION_ADD|gene|a|b.vmd',
    'MODEL_BINDFACE|MaAI_Blink|0|1|gene|まばたき|0|1',
  ]);
});

test('a line split across frames waits for its newline', () => {
  const { stream, got } = collect();
  stream.pushText('KEYVALUE_SET|a|');
  assert.deepEqual(got.messages, []);
  stream.pushText('1\n');
  assert.deepEqual(got.messages, ['KEYVALUE_SET|a|1']);
});

test('audio chunks, control headers, and chunks split across frames', () => {
  const { stream, got } = collect();
  stream.pushText('SNDFILE\n');
  const chunk = sndChunk([1, -2, 32767]);
  stream.pushBinary(chunk.subarray(0, 5));
  assert.deepEqual(got.sound, []);
  stream.pushBinary(chunk.subarray(5));
  assert.deepEqual(got.sound, [[1, -2, 32767]]);
  // two chunks in one frame
  const two = new Uint8Array([...sndChunk([3]), ...sndChunk([4, 5])]);
  stream.pushBinary(two);
  stream.pushText('SNDBRKS\n');
  assert.deepEqual(got.sound, [[1, -2, 32767], [3], [4, 5]]);
  assert.deepEqual(got.modes, ['FILE']);
  assert.equal(got.breaks, 1);
  assert.equal(stream.pending(), 0);
});

test('messages starting with S are still text', () => {
  const { stream, got } = collect();
  stream.pushText('STAGE|a.png,b.png\nSYNTH_START|0|v|hi\n');
  assert.deepEqual(got.messages, ['STAGE|a.png,b.png', 'SYNTH_START|0|v|hi']);
});

test('messages are sent back as TYPE|args lines', () => {
  assert.equal(formatMessage('MODEL_EVENT_ADD', 'gene'), 'MODEL_EVENT_ADD|gene\n');
  assert.equal(formatMessage('KEY', ''), 'KEY\n');
});
