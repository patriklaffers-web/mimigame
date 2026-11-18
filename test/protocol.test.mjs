// Cross-checks the JS protocol helpers against vectors produced by LEGO's
// reference Python algorithms (spike-prime-docs, examples/python).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pack, unpack, cobsEncode, cobsDecode, crc32, build, parseMessage } from '../spike.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url)));
const hex = (u) => Buffer.from(u).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

for (const v of vectors.cobs) {
  const data = bytes(v.data);
  assert.equal(hex(cobsEncode(data)), v.encoded, `encode ${v.data}`);
  assert.equal(hex(pack(data)), v.packed, `pack ${v.data}`);
  assert.equal(hex(cobsDecode(bytes(v.encoded))), v.data, `decode ${v.data}`);
  assert.equal(hex(unpack(bytes(v.packed))), v.data, `unpack ${v.data}`);
  assert.equal(hex(unpack(bytes('01' + v.packed))), v.data, `unpack high-priority ${v.data}`);
}
for (const v of vectors.crc) assert.equal(crc32(bytes(v.data), v.seed), v.crc, `crc ${v.data}`);
for (const v of vectors.messages) {
  const args = v.args.map((a) => (typeof a === 'string' && a.startsWith('hex:') ? bytes(a.slice(4)) : a));
  assert.equal(hex(build[v.fn](...args)), v.out, v.fn);
}
const info = parseMessage(bytes(vectors.info));
assert.equal(info.maxPacketSize, 20);
assert.equal(info.maxChunkSize, 84);
assert.equal(info.firmware, '1.2.3');

// Running CRC over 4-byte aligned chunks must equal the whole-file CRC.
const file = Uint8Array.from({ length: 1001 }, (_, i) => (i * 37) & 0xff);
let running = 0;
for (let i = 0; i < file.length; i += 84) running = crc32(file.subarray(i, i + 84), running);
assert.equal(running, crc32(file));

console.log(`ok: ${vectors.cobs.length} cobs, ${vectors.crc.length} crc, ${vectors.messages.length} message vectors`);
