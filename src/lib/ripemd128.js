/**
 * RIPEMD-128, needed to derive the key that unscrambles the key index of
 * dictionaries marked Encrypted="2".
 */

// Message word order and rotation amounts, left and right line.
const RL = Uint8Array.from([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
]);
const RR = Uint8Array.from([
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
]);
const SL = Uint8Array.from([
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
]);
const SR = Uint8Array.from([
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
]);
const KL = Uint32Array.from([0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc]);
const KR = Uint32Array.from([0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000]);

function f(round, x, y, z) {
  switch (round) {
    case 0:
      return x ^ y ^ z;
    case 1:
      return (x & y) | (~x & z);
    case 2:
      return (x | ~y) ^ z;
    default:
      return (x & z) | (y & ~z);
  }
}

const rol = (value, bits) => (value << bits) | (value >>> (32 - bits));

/**
 * @param {Uint8Array} message
 * @returns {Uint8Array} 16-byte digest
 */
export function ripemd128(message) {
  const length = message.length;
  const padded = new Uint8Array(((length + 8) >> 6) * 64 + 64);
  padded.set(message);
  padded[length] = 0x80;
  const tail = new DataView(padded.buffer);
  tail.setUint32(padded.length - 8, (length << 3) >>> 0, true);
  tail.setUint32(padded.length - 4, Math.floor(length / 536870912), true);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  const x = new Uint32Array(16);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) x[i] = tail.getUint32(offset + i * 4, true);

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let aa = h0;
    let bb = h1;
    let cc = h2;
    let dd = h3;

    for (let j = 0; j < 64; j++) {
      const round = j >> 4;
      let t = (a + f(round, b, c, d) + x[RL[j]] + KL[round]) | 0;
      t = rol(t, SL[j]);
      a = d;
      d = c;
      c = b;
      b = t;

      t = (aa + f(3 - round, bb, cc, dd) + x[RR[j]] + KR[round]) | 0;
      t = rol(t, SR[j]);
      aa = dd;
      dd = cc;
      cc = bb;
      bb = t;
    }

    const t = (h1 + c + dd) | 0;
    h1 = (h2 + d + aa) | 0;
    h2 = (h3 + a + bb) | 0;
    h3 = (h0 + b + cc) | 0;
    h0 = t;
  }

  const digest = new Uint8Array(16);
  const view = new DataView(digest.buffer);
  view.setUint32(0, h0 >>> 0, true);
  view.setUint32(4, h1 >>> 0, true);
  view.setUint32(8, h2 >>> 0, true);
  view.setUint32(12, h3 >>> 0, true);
  return digest;
}
