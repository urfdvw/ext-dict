/**
 * LZO1X decompressor.
 *
 * MDict blocks may be stored with compression type 1, which is a raw LZO1X
 * stream (the same bytes `lzo1x_decompress` consumes, without any header).
 * This is a straight transcription of the LZO1X decoding rules; the `state`
 * variable stands in for the `goto` labels of the reference decoder.
 */

const TOP = 0;
const FIRST_LITERAL_RUN = 1;
const MATCH = 2;
const COPY_MATCH = 3;
const MATCH_DONE = 4;
const MATCH_NEXT = 5;

export class LzoError extends Error {}

/**
 * @param {Uint8Array} src raw LZO1X stream
 * @param {number} dstLen exact decompressed size (known from the block header)
 * @returns {Uint8Array}
 */
export function lzoDecompress(src, dstLen) {
  const dst = new Uint8Array(dstLen);
  const srcLen = src.length;
  let ip = 0;
  let op = 0;
  let t = 0;
  let mPos = 0;
  let state = TOP;

  const fail = (why) => {
    throw new LzoError(`LZO stream is malformed (${why}) at in=${ip} out=${op}`);
  };
  const literals = (n) => {
    if (ip + n > srcLen || op + n > dstLen) fail('literal run overruns');
    while (n-- > 0) dst[op++] = src[ip++];
  };
  const longLength = (base) => {
    // A zero length nibble means the length is spread over following bytes.
    let n = 0;
    while (ip < srcLen && src[ip] === 0) {
      n += 255;
      ip++;
    }
    if (ip >= srcLen) fail('truncated length');
    return n + base + src[ip++];
  };

  if (srcLen === 0) fail('empty input');

  if (src[ip] > 17) {
    t = src[ip++] - 17;
    if (t < 4) {
      state = MATCH_NEXT;
    } else {
      literals(t);
      state = FIRST_LITERAL_RUN;
    }
  }

  for (;;) {
    switch (state) {
      case TOP: {
        if (ip >= srcLen) fail('truncated opcode');
        t = src[ip++];
        if (t >= 16) {
          state = MATCH;
          break;
        }
        if (t === 0) t = longLength(15);
        literals(t + 3);
        state = FIRST_LITERAL_RUN;
        break;
      }

      case FIRST_LITERAL_RUN: {
        if (ip >= srcLen) fail('truncated opcode');
        t = src[ip++];
        if (t >= 16) {
          state = MATCH;
          break;
        }
        mPos = op - 1 - 0x0800 - (t >> 2) - (src[ip++] << 2);
        if (mPos < 0 || op + 3 > dstLen) fail('bad short match');
        dst[op++] = dst[mPos++];
        dst[op++] = dst[mPos++];
        dst[op++] = dst[mPos++];
        state = MATCH_DONE;
        break;
      }

      case MATCH: {
        if (t >= 64) {
          mPos = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
          t = (t >> 5) - 1;
          state = COPY_MATCH;
        } else if (t >= 32) {
          t &= 31;
          if (t === 0) t = longLength(31);
          if (ip + 2 > srcLen) fail('truncated distance');
          mPos = op - 1 - ((src[ip] | (src[ip + 1] << 8)) >> 2);
          ip += 2;
          state = COPY_MATCH;
        } else if (t >= 16) {
          mPos = op - ((t & 8) << 11);
          t &= 7;
          if (t === 0) t = longLength(7);
          if (ip + 2 > srcLen) fail('truncated distance');
          mPos -= (src[ip] | (src[ip + 1] << 8)) >> 2;
          ip += 2;
          if (mPos === op) return dst.subarray(0, op); // end of stream marker
          mPos -= 0x4000;
          state = COPY_MATCH;
        } else {
          mPos = op - 1 - (t >> 2) - (src[ip++] << 2);
          if (mPos < 0 || op + 2 > dstLen) fail('bad short match');
          dst[op++] = dst[mPos++];
          dst[op++] = dst[mPos++];
          state = MATCH_DONE;
        }
        break;
      }

      case COPY_MATCH: {
        const n = t + 2;
        if (mPos < 0 || op + n > dstLen) fail('match refers outside the window');
        for (let i = 0; i < n; i++) dst[op++] = dst[mPos++];
        state = MATCH_DONE;
        break;
      }

      case MATCH_DONE: {
        t = src[ip - 2] & 3;
        state = t === 0 ? TOP : MATCH_NEXT;
        break;
      }

      case MATCH_NEXT: {
        literals(t);
        if (ip >= srcLen) fail('truncated opcode');
        t = src[ip++];
        state = MATCH;
        break;
      }
    }
  }
}
