// fixed.js — 8.8固定小数点ユーティリティと16方向テーブル
export const FP = 8;

// 整数 → 8.8固定小数点
export function f(n) {
  return n << FP;
}

// 8.8固定小数点 → 画面px整数
export function toPx(v) {
  return v >> FP;
}

// 8.8固定小数点同士の乗算 = (a*b)>>8
export function fmul(a, b) {
  return (a * b) >> FP;
}

// index0=上、時計回りに22.5度刻み、長さ256の8.8固定小数点ベクトル
export const DIR16 = [
  { dx: 0, dy: -256 },
  { dx: 98, dy: -236 },
  { dx: 181, dy: -181 },
  { dx: 236, dy: -98 },
  { dx: 256, dy: 0 },
  { dx: 236, dy: 98 },
  { dx: 181, dy: 181 },
  { dx: 98, dy: 236 },
  { dx: 0, dy: 256 },
  { dx: -98, dy: 236 },
  { dx: -181, dy: 181 },
  { dx: -236, dy: 98 },
  { dx: -256, dy: 0 },
  { dx: -236, dy: -98 },
  { dx: -181, dy: -181 },
  { dx: -98, dy: -236 },
];

// 差分ベクトル(dx,dy)からDIR16のindexを返す。象限判定＋整数比較のみ。三角関数禁止。
export function aim16(dx, dy) {
  let ax = dx < 0 ? -dx : dx;
  let ay = dy < 0 ? -dy : dy;

  // オーバーフロー回避のため大きい値は縮小する
  while (ax > 0x7fffff || ay > 0x7fffff) {
    ax >>= 4;
    ay >>= 4;
  }

  let k;
  if (ax * 256 < ay * 51) {
    k = 0;
  } else if (ax * 256 < ay * 171) {
    k = 1;
  } else if (ax * 256 < ay * 383) {
    k = 2;
  } else if (ax * 256 < ay * 1287) {
    k = 3;
  } else {
    k = 4;
  }

  if (dx >= 0 && dy <= 0) {
    return k;
  } else if (dx >= 0 && dy > 0) {
    return 8 - k;
  } else if (dx < 0 && dy > 0) {
    return 8 + k;
  } else {
    return (16 - k) % 16;
  }
}
