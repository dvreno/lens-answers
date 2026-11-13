// Binary audio chunk format shared by the glasses plugin (browser) and the
// server (Node). Plain ESM, no Node-only APIs.
//
//   u16 LE frameCount | frameCount x u16 LE length | frame bytes, back to back

const U16_MAX = 0xffff;

/**
 * @param {number[]} frameLengths byte length of each Opus frame
 * @param {Uint8Array} data the frames concatenated
 * @returns {Uint8Array}
 */
export function encodeChunk(frameLengths, data) {
  const count = frameLengths.length;
  if (count > U16_MAX) throw new RangeError('too many frames for one chunk');
  let sum = 0;
  for (const n of frameLengths) {
    if (!Number.isInteger(n) || n < 0 || n > U16_MAX) throw new RangeError('bad frame length');
    sum += n;
  }
  if (sum !== data.length) throw new RangeError('frame lengths do not match data');
  const headerSize = 2 + 2 * count;
  const out = new Uint8Array(headerSize + data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, count, true);
  frameLengths.forEach((n, i) => view.setUint16(2 + 2 * i, n, true));
  out.set(data, headerSize);
  return out;
}

/**
 * @param {Uint8Array} buf
 * @returns {{frames: Uint8Array[]}} frames are copies, safe to keep
 * @throws {RangeError} when the header or lengths do not fit the payload
 */
export function decodeChunk(buf) {
  if (buf.length < 2) throw new RangeError('chunk too short');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint16(0, true);
  const headerSize = 2 + 2 * count;
  if (buf.length < headerSize) throw new RangeError('chunk header truncated');
  const frames = [];
  let pos = headerSize;
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(2 + 2 * i, true);
    if (pos + len > buf.length) throw new RangeError('frame lengths exceed payload');
    // Uint8Array.prototype.slice always copies; Buffer#slice would alias.
    frames.push(Uint8Array.prototype.slice.call(buf, pos, pos + len));
    pos += len;
  }
  if (pos !== buf.length) throw new RangeError('frame lengths do not cover payload');
  return { frames };
}
