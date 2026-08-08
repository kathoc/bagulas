// rng.js — 8bit LFSR 乱数（タップ 0xB8 相当）。Math.random 禁止。
let state = 1;

export function seed(s) {
  state = s & 0xff;
  if (state === 0) {
    state = 1;
  }
}

export function rnd8() {
  // 8bit Galois LFSR, タップマスク 0xB8
  const lsb = state & 1;
  state >>= 1;
  if (lsb) {
    state ^= 0xb8;
  }
  return state & 0xff;
}

export function rndRange(n) {
  return rnd8() % n;
}
