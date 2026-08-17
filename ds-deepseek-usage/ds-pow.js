// ds-pow.js — DeepSeekHashV1 proof-of-work solver.
// Algorithm reverse-engineered from the DeepSeek Platform frontend bundle
// (verified byte-for-byte against the official sha3_wasm_bg.wasm solver):
//   prefix = salt + "_" + expireAt + "_"
//   answer = smallest n in [0, difficulty) with customHash(prefix + String(n))
//            === challenge, where customHash is a Keccak-f[1600] variant
//            (capacity 256 / rate 136, rounds 1..23 — iota round 0 is skipped).
// The custom hash was confirmed to match the official wasm_deepseek_hash_v1
// on multiple test vectors.

const ROUND_CONSTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROT_LANE = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]
const ROT_OFF = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44]

const MASK64 = 0xffffffffffffffffn

function rotl64(x, n) {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64
}

/** Keccak-f[1600] permutation, rounds [start, end) — DeepSeek uses 1..23. */
function keccakF(state, start, end) {
  for (let round = start; round < end; round++) {
    // theta
    const C = new Array(5)
    for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1)
      for (let y = 0; y < 5; y++) state[x + 5 * y] ^= d
    }
    // rho + pi
    let x = 1, y = 0, cur = state[1]
    for (let t = 0; t < 24; t++) {
      const nx = ROT_LANE[t] % 5
      const ny = Math.floor(ROT_LANE[t] / 5)
      const tmp = state[nx + 5 * ny]
      state[nx + 5 * ny] = rotl64(cur, ROT_OFF[t])
      cur = tmp
      x = nx; y = ny
    }
    // chi
    for (let yy = 0; yy < 5; yy++) {
      const row = [0, 1, 2, 3, 4].map((xx) => state[xx + 5 * yy])
      for (let xx = 0; xx < 5; xx++) state[xx + 5 * yy] = row[xx] ^ (~row[(xx + 1) % 5] & row[(xx + 2) % 5])
    }
    // iota
    state[0] ^= ROUND_CONSTS[round]
  }
}

const RATE = 136 // 1600 - 2*256 bits
const PADDING = 0x06 // SHA3 domain byte

/**
 * The DeepSeekHashV1 sponge: 32-byte digest of a utf-8 string.
 * Matches the platform's wasm_deepseek_hash_v1 (verified).
 */
export function deepseekHashV1(input) {
  const bytes = new TextEncoder().encode(input)
  const state = new Array(25).fill(0n)
  // absorb message in rate-sized blocks
  let offset = 0
  while (offset + RATE <= bytes.length) {
    for (let i = 0; i < RATE; i++) {
      const lane = i >> 3
      state[lane] ^= BigInt(bytes[offset + i]) << BigInt(8 * (i & 7))
    }
    keccakF(state, 1, 24)
    offset += RATE
  }
  // final block + pad 0x06 ... 0x80
  const rest = bytes.length - offset
  for (let i = 0; i < RATE; i++) {
    let byte = i < rest ? bytes[offset + i] : 0
    if (i === rest) byte |= PADDING
    if (i === RATE - 1) byte |= 0x80
    const lane = i >> 3
    state[lane] ^= BigInt(byte) << BigInt(8 * (i & 7))
  }
  keccakF(state, 1, 24)
  // squeeze 32 bytes
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = Number((state[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn)
  }
  return Buffer.from(out).toString('hex')
}

/**
 * Solve a DeepSeekHashV1 challenge: find n in [0, difficulty) with
 * deepseekHashV1(salt + "_" + expireAt + "_" + n) === challenge.
 * @returns {number|null} the answer nonce, or null when no solution in range.
 */
export function solveDeepSeekPow(challenge, salt, expireAt, difficulty) {
  const prefix = salt + '_' + expireAt + '_'
  for (let n = 0; n < difficulty; n++) {
    if (deepseekHashV1(prefix + String(n)) === challenge) return n
  }
  return null
}
