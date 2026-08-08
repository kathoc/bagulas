// hitbox.js — 中心基準の当たり判定API。
// 判定は必ず「中心座標 + 半径(halfW, halfH)」で行う。左上基準の生座標を直接渡すAPIは公開しない。
import { f } from './fixed.js';
import { TILE16_ENEMY_A, TILE16_ENEMY_B, TILE16_ROCK, TILE16_FENCE, TILE16_CACTUS } from './tiles.js';

// 左上座標→判定中心座標への変換はこの関数1つに集約する。
// halfSpriteSize: そのスプライトの半サイズ(8.8固定小数点)。16x16ならSPRITE_HALF_16、
// 32x32ならSPRITE_HALF_32、8x8弾タイルならSPRITE_HALF_8を渡す。
export function centerCoord(topLeft, halfSpriteSize) {
  return topLeft + halfSpriteSize;
}

// 中心基準AABB判定(中心座標+半径)。
export function hitOverlap(acx, acy, ahw, ahh, bcx, bcy, bhw, bhh) {
  const dx = acx - bcx;
  const dy = acy - bcy;
  const adx = dx < 0 ? -dx : dx;
  const ady = dy < 0 ? -dy : dy;
  return adx < ahw + bhw && ady < ahh + bhh;
}

// スプライトの半サイズ(左上→中心オフセット)。8.8固定小数点。モジュール初期化時に1回だけ計算。
export const SPRITE_HALF_16 = f(8); // 16x16キャラ/障害物(自機・敵A/B・ROCK/FENCE/CACTUS)
export const SPRITE_HALF_32 = f(16); // 32x32ボス
export const SPRITE_HALF_8 = f(4); // 8x8弾タイル(自弾3種・敵弾とも8x8)

// 判定サイズ(half w/h)。すべてアート実測(不透明bbox/芯)に基づく採用値。目分量ではない。
// 自機: アート実測 15×16(芯14×15) に対し中央8×8(half f(4),f(4))を採る。
export const PLAYER_HITBOX = { hw: f(4), hh: f(4) };
// ボス: アート実測 32×32(芯32×31) に対し24×24(half f(12),f(12))を採る。
export const BOSS_HITBOX = { hw: f(12), hh: f(12) };
// 自弾・敵弾: 見た目の芯だけを取る4×4(half f(2),f(2))。
export const PLAYER_BULLET_HITBOX = { hw: f(2), hh: f(2) };
export const ENEMY_BULLET_HITBOX = { hw: f(2), hh: f(2) };

// 敵は編隊種別ではなく使用タイルで判定サイズが決まる。
const ENEMY_HITBOX_BY_TILE = new Map([
  // TILE16_ENEMY_A(バイク): アート実測 8×16(芯8×11) に対し8×10(half f(4),f(5))を採る。
  [TILE16_ENEMY_A, { hw: f(4), hh: f(5) }],
  // TILE16_ENEMY_B(車): アート実測 14×16(芯14×16) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_B, { hw: f(6), hh: f(6) }],
]);

const OBSTACLE_HITBOX_BY_TILE = new Map([
  // ROCK: アート実測 16×16(芯15×16) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ROCK, { hw: f(6), hh: f(6) }],
  // CACTUS: アート実測 16×14(芯14×14) に対し10×12(half f(5),f(6))を採る。
  [TILE16_CACTUS, { hw: f(5), hh: f(6) }],
  // FENCE: アート実測 16×4(芯14×3) に対し12×4(half f(6),f(2))を採る。
  [TILE16_FENCE, { hw: f(6), hh: f(2) }],
]);

export function enemyHitboxForTile(tile) {
  return ENEMY_HITBOX_BY_TILE.get(tile) || ENEMY_HITBOX_BY_TILE.get(TILE16_ENEMY_A);
}

export function obstacleHitboxForTile(tile) {
  return OBSTACLE_HITBOX_BY_TILE.get(tile) || OBSTACLE_HITBOX_BY_TILE.get(TILE16_ROCK);
}
