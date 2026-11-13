// Test helper: pull Opus audio packets out of an Ogg container.
// Header packets (OpusHead, OpusTags) are skipped. Packets spanning
// segments or pages are reassembled.

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

export function oggPackets(buf) {
  const packets = [];
  let pending = [];
  let pos = 0;
  while (pos < buf.length) {
    if (CAPTURE.some((b, i) => buf[pos + i] !== b)) {
      throw new Error(`not an Ogg page at offset ${pos}`);
    }
    const segCount = buf[pos + 26];
    const table = buf.subarray(pos + 27, pos + 27 + segCount);
    let dataPos = pos + 27 + segCount;
    for (const len of table) {
      pending.push(buf.subarray(dataPos, dataPos + len));
      dataPos += len;
      if (len < 255) {
        packets.push(concat(pending));
        pending = [];
      }
    }
    pos = dataPos;
  }
  if (pending.length) packets.push(concat(pending));
  return packets.slice(2);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
