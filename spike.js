// SPIKE Prime / Essential hub BLE protocol (SPIKE App 3 firmware).
// Implements framing, COBS, CRC32 and the request/response messages documented
// at https://lego.github.io/spike-prime-docs/

export const SERVICE = '0000fd02-0000-1000-8000-00805f9b34fb';
export const RX_CHAR = '0000fd02-0001-1000-8000-00805f9b34fb'; // hub receives
export const TX_CHAR = '0000fd02-0002-1000-8000-00805f9b34fb'; // hub transmits

export const MSG = {
  InfoRequest: 0x00, InfoResponse: 0x01,
  StartFileUploadRequest: 0x0c, StartFileUploadResponse: 0x0d,
  TransferChunkRequest: 0x10, TransferChunkResponse: 0x11,
  ProgramFlowRequest: 0x1e, ProgramFlowResponse: 0x1f, ProgramFlowNotification: 0x20,
  ConsoleNotification: 0x21,
  DeviceNotificationRequest: 0x28, DeviceNotificationResponse: 0x29,
  TunnelMessage: 0x32,
  DeviceNotification: 0x3c,
  ClearSlotRequest: 0x46, ClearSlotResponse: 0x47,
};

// ---------------------------------------------------------------- COBS ------
const DELIMITER = 0x02;
const NO_DELIMITER = 0xff;
const MAX_BLOCK_SIZE = 84;
const XOR = 0x03;

export function cobsEncode(data) {
  const out = [];
  let codeIndex = 0, block = 0;
  const begin = () => { codeIndex = out.length; out.push(NO_DELIMITER); block = 1; };
  begin();
  for (const byte of data) {
    if (byte > DELIMITER) { out.push(byte); block++; }
    if (byte <= DELIMITER || block > MAX_BLOCK_SIZE) {
      if (byte <= DELIMITER) out[codeIndex] = byte * MAX_BLOCK_SIZE + block + DELIMITER;
      begin();
    }
  }
  out[codeIndex] = block + DELIMITER;
  return Uint8Array.from(out);
}

export function cobsDecode(data) {
  const out = [];
  const unescape = (code) => {
    if (code === 0xff) return [null, MAX_BLOCK_SIZE + 1];
    let value = Math.floor((code - DELIMITER) / MAX_BLOCK_SIZE);
    let block = (code - DELIMITER) % MAX_BLOCK_SIZE;
    if (block === 0) { block = MAX_BLOCK_SIZE; value -= 1; }
    return [value, block];
  };
  let [value, block] = unescape(data[0]);
  for (let i = 1; i < data.length; i++) {
    block--;
    if (block > 0) { out.push(data[i]); continue; }
    if (value !== null) out.push(value);
    [value, block] = unescape(data[i]);
  }
  return Uint8Array.from(out);
}

export function pack(payload) {
  const enc = cobsEncode(payload);
  const out = new Uint8Array(enc.length + 1);
  for (let i = 0; i < enc.length; i++) out[i] = enc[i] ^ XOR;
  out[enc.length] = DELIMITER;
  return out;
}

export function unpack(frame) {
  let start = frame[0] === 0x01 ? 1 : 0;
  const body = frame.slice(start, frame[frame.length - 1] === DELIMITER ? -1 : undefined);
  return cobsDecode(body.map((b) => b ^ XOR));
}

// --------------------------------------------------------------- CRC32 ------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** zlib-compatible crc32 with seed, data zero-padded to 4-byte alignment. */
export function crc32(data, seed = 0) {
  const rem = data.length % 4;
  if (rem) { const p = new Uint8Array(data.length + 4 - rem); p.set(data); data = p; }
  let c = (seed ^ 0xffffffff) >>> 0;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------- Message builders ---
const enc = new TextEncoder();
const dec = new TextDecoder();

export const build = {
  info: () => Uint8Array.of(MSG.InfoRequest),
  clearSlot: (slot) => Uint8Array.of(MSG.ClearSlotRequest, slot),
  programFlow: (stop, slot) => Uint8Array.of(MSG.ProgramFlowRequest, stop ? 1 : 0, slot),
  deviceNotifications: (ms) => Uint8Array.of(MSG.DeviceNotificationRequest, ms & 0xff, (ms >> 8) & 0xff),
  startFileUpload(name, slot, crc) {
    const n = enc.encode(name);
    if (n.length > 31) throw new Error('File name too long');
    const b = new Uint8Array(1 + n.length + 1 + 1 + 4);
    const v = new DataView(b.buffer);
    b[0] = MSG.StartFileUploadRequest;
    b.set(n, 1);
    b[1 + n.length] = 0; // null terminator
    b[2 + n.length] = slot;
    v.setUint32(3 + n.length, crc, true);
    return b;
  },
  transferChunk(runningCrc, chunk) {
    const b = new Uint8Array(7 + chunk.length);
    const v = new DataView(b.buffer);
    b[0] = MSG.TransferChunkRequest;
    v.setUint32(1, runningCrc, true);
    v.setUint16(5, chunk.length, true);
    b.set(chunk, 7);
    return b;
  },
};

// ------------------------------------------------------- Message parsing ----
const DEVICE_MESSAGES = {
  0x00: ['battery', 2, (v) => ({ level: v.getUint8(1) })],
  0x01: ['imu', 21, (v) => ({
    faceUp: v.getUint8(1), yawFace: v.getUint8(2),
    yaw: v.getInt16(3, true), pitch: v.getInt16(5, true), roll: v.getInt16(7, true),
  })],
  0x02: ['matrix', 26, () => ({})],
  0x0a: ['motor', 12, (v) => ({
    port: v.getUint8(1), type: v.getUint8(2), absPos: v.getInt16(3, true),
    power: v.getInt16(5, true), speed: v.getInt8(7), position: v.getInt32(8, true),
  })],
  0x0b: ['force', 4, (v) => ({ port: v.getUint8(1), value: v.getUint8(2), pressed: !!v.getUint8(3) })],
  0x0c: ['color', 10, (v) => ({
    port: v.getUint8(1), color: v.getInt8(2),
    r: v.getUint16(3, true), g: v.getUint16(5, true), b: v.getUint16(7, true),
  })],
  0x0d: ['distance', 4, (v) => ({ port: v.getUint8(1), mm: v.getInt16(2, true) })],
  0x0e: ['matrix3x3', 11, (v) => ({ port: v.getUint8(1) })],
};

export function parseDevicePayload(p) {
  const out = [];
  let i = 0;
  while (i < p.length) {
    const def = DEVICE_MESSAGES[p[i]];
    if (!def || i + def[1] > p.length) break;
    const v = new DataView(p.buffer, p.byteOffset + i, def[1]);
    out.push({ kind: def[0], ...def[2](v) });
    i += def[1];
  }
  return out;
}

export function parseMessage(m) {
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const id = m[0];
  switch (id) {
    case MSG.InfoResponse:
      return {
        id, rpc: `${m[1]}.${m[2]}.${v.getUint16(3, true)}`,
        firmware: `${m[5]}.${m[6]}.${v.getUint16(7, true)}`,
        maxPacketSize: v.getUint16(9, true), maxMessageSize: v.getUint16(11, true),
        maxChunkSize: v.getUint16(13, true), productGroupDevice: v.getUint16(15, true),
      };
    case MSG.StartFileUploadResponse: case MSG.TransferChunkResponse:
    case MSG.ProgramFlowResponse: case MSG.DeviceNotificationResponse:
    case MSG.ClearSlotResponse:
      return { id, success: m[1] === 0 };
    case MSG.ProgramFlowNotification:
      return { id, stopped: !!m[1] };
    case MSG.ConsoleNotification: {
      let end = m.indexOf(0, 1); if (end < 0) end = m.length;
      return { id, text: dec.decode(m.subarray(1, end)) };
    }
    case MSG.DeviceNotification: {
      const size = v.getUint16(1, true);
      return { id, devices: parseDevicePayload(m.subarray(3, 3 + size)) };
    }
    default:
      return { id };
  }
}

// ------------------------------------------------------------------ Hub -----
const RESPONSE_FOR = {
  [MSG.InfoRequest]: MSG.InfoResponse,
  [MSG.StartFileUploadRequest]: MSG.StartFileUploadResponse,
  [MSG.TransferChunkRequest]: MSG.TransferChunkResponse,
  [MSG.ProgramFlowRequest]: MSG.ProgramFlowResponse,
  [MSG.DeviceNotificationRequest]: MSG.DeviceNotificationResponse,
  [MSG.ClearSlotRequest]: MSG.ClearSlotResponse,
};

export class Hub extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.info = null;
    this._queue = Promise.resolve();
    this._pending = null;
    this._buf = { low: [], high: [], cur: null };
  }

  get connected() { return !!this.device?.gatt?.connected; }

  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop or Android).');
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    this.device.addEventListener('gattserverdisconnected', () => {
      this._rejectPending(new Error('Disconnected'));
      this.dispatchEvent(new Event('disconnect'));
    });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    this.rx = await service.getCharacteristic(RX_CHAR);
    const tx = await service.getCharacteristic(TX_CHAR);
    tx.addEventListener('characteristicvaluechanged', (e) => {
      this._onBytes(new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength));
    });
    await tx.startNotifications();
    this.info = await this.request(build.info());
    return this.info;
  }

  disconnect() { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); }

  _onBytes(bytes) {
    const b = this._buf;
    for (const byte of bytes) {
      if (byte === 0x01) { // start of high-priority message
        if (b.cur === 'high') b.high = [];
        b.cur = 'high';
      } else if (byte === 0x02) { // end of message
        const which = b.cur ?? 'low';
        const frame = b[which];
        b[which] = [];
        b.cur = which === 'high' && b.low.length ? 'low' : null;
        if (frame.length) this._onFrame(Uint8Array.from(frame));
      } else {
        b[b.cur ?? 'low'].push(byte);
        if (!b.cur) b.cur = 'low';
      }
    }
  }

  _onFrame(frame) {
    let msg;
    try { msg = parseMessage(unpack(frame)); } catch (e) { console.warn('Bad frame', e); return; }
    if (this._pending && this._pending.expect === msg.id) {
      const p = this._pending; this._pending = null; clearTimeout(p.timer); p.resolve(msg);
    }
    this.dispatchEvent(Object.assign(new Event('message'), { message: msg }));
  }

  _rejectPending(err) {
    if (this._pending) { const p = this._pending; this._pending = null; clearTimeout(p.timer); p.reject(err); }
  }

  async _write(payload) {
    const frame = pack(payload);
    const size = this.info?.maxPacketSize || frame.length;
    for (let i = 0; i < frame.length; i += size) {
      await this.rx.writeValueWithoutResponse(frame.subarray(i, i + size));
    }
  }

  /** Send a request and wait for its response. Requests are serialized. */
  request(payload, timeoutMs = 5000) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected'));
      const timer = setTimeout(() => { this._pending = null; reject(new Error('Hub did not respond')); }, timeoutMs);
      this._pending = { expect: RESPONSE_FOR[payload[0]], resolve, reject, timer };
      this._write(payload).catch((e) => this._rejectPending(e));
    });
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  enableDeviceNotifications(intervalMs = 250) { return this.request(build.deviceNotifications(intervalMs)); }
  startProgram(slot) { return this.request(build.programFlow(false, slot)); }
  stopProgram(slot) { return this.request(build.programFlow(true, slot)); }

  /** Upload Python source into a program slot. */
  async uploadProgram(slot, source, name = 'program.py') {
    const data = enc.encode(source);
    await this.request(build.clearSlot(slot)); // NACK just means the slot was empty
    const start = await this.request(build.startFileUpload(name, slot, crc32(data)));
    if (!start.success) throw new Error(`Hub refused upload to slot ${slot}`);
    // keep chunks 4-byte aligned so the running CRC matches the file CRC
    const chunkSize = Math.max(4, (this.info?.maxChunkSize || 256) & ~3);
    let running = 0;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.subarray(i, i + chunkSize);
      running = crc32(chunk, running);
      const r = await this.request(build.transferChunk(running, chunk));
      if (!r.success) throw new Error(`Chunk transfer failed (slot ${slot})`);
    }
  }
}
