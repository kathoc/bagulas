// hitbox.js — 中心基準の当たり判定API。
// 判定は必ず「中心座標 + 半径(halfW, halfH)」で行う。左上基準の生座標を直接渡すAPIは公開しない。
import { f } from './fixed.js';
import {
  TILE16_ENEMY_A,
  TILE16_ENEMY_B,
  TILE16_ROCK,
  TILE16_FENCE,
  TILE16_CACTUS,
  TILE16_ENEMY_SCATTER,
  TILE16_ENEMY_DRIFTER,
  TILE16_ENEMY_REAPER,
  TILE16_ENEMY_GUNWAGON,
  TILE16_ENEMY_WHEELSAW,
  TILE16_ENEMY_HOPPER,
  TILE16_ENEMY_SANDWORM,
  TILE16_ENEMY_SIDECAR,
  TILE16_ENEMY_MOTHER,
  TILE16_ENEMY_MIRAGE,
  TILE16_ENEMY_CHASER,
} from './tiles.js';

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
// 自弾: 見た目より広く取る10×10(half f(5),f(5))。リボルバーの芯は4×8、鉄球・ダイナマイトは
// 8×8いっぱいという実測に対し、狙って当てる快感を優先して「当たったはずなのに抜けた」を無くす
// 採用値(docs/spec.md「自弾の判定は大きめに取る」方針)。自機に有利な方向へ判定を倒す。
export const PLAYER_BULLET_HITBOX = { hw: f(5), hh: f(5) };
// 敵弾: 見た目8×8いっぱいに対し、中心の実質的に濃い「芯」だけを取る2×2(half f(1),f(1))。
// 「避けたはずなのに当たった」を無くすため、あえて見た目より小さく倒す採用値
// (docs/spec.md「敵弾の判定は小さく取る」方針)。
export const ENEMY_BULLET_HITBOX = { hw: f(1), hh: f(1) };

// 敵は編隊種別ではなく使用タイルで判定サイズが決まる。
const ENEMY_HITBOX_BY_TILE = new Map([
  // TILE16_ENEMY_A(バイク): アート実測 8×16(芯8×11) に対し8×10(half f(4),f(5))を採る。
  [TILE16_ENEMY_A, { hw: f(4), hh: f(5) }],
  // TILE16_ENEMY_B(車): アート実測 14×16(芯14×16) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_B, { hw: f(6), hh: f(6) }],
  // 段階3(敵5種)。half値は全てtools実測(不透明ピクセルのbbox, y=0..15/x=0..15走査)から
  // 数px内側へ削って採用した値（docs/enemies.mdの判定は見た目より小さく取る方針に合わせる）。
  // TILE16_ENEMY_SCATTER: アート実測 15×16(x1-15,y0-15) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_SCATTER, { hw: f(6), hh: f(6) }],
  // TILE16_ENEMY_DRIFTER: アート実測 16×16(全域) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_DRIFTER, { hw: f(6), hh: f(6) }],
  // TILE16_ENEMY_REAPER: 再生成後のアート実測 bbox4×11(x6-9,y2-12。旗を立てた細身の車体)。
  // 旧アート(12×15)向けの10×12は絵より広くなってしまうため、4×8(half f(2),f(4))へ縮める。
  [TILE16_ENEMY_REAPER, { hw: f(2), hh: f(4) }],
  // TILE16_ENEMY_GUNWAGON: アート実測 15×16(x0-14,y0-15) に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_GUNWAGON, { hw: f(6), hh: f(6) }],
  // TILE16_ENEMY_WHEELSAW: アート実測 16×16(全域、丸い鋸刃で四隅まで塗りが及ぶ) に対し
  // 12×12(half f(6),f(6))を採る。破壊不能だが自機接触判定には使うため必要。
  [TILE16_ENEMY_WHEELSAW, { hw: f(6), hh: f(6) }],
  // 段階3グループ2(依頼元コーディネーターの実測に基づく採用値。根拠はdocs/enemies.md追記分に準拠)。
  // TILE16_ENEMY_HOPPER: 再生成後のアート実測 bbox8×8(x4-11,y4-11。脚が四方へ張り出す)。
  // 脚の隙間まで当たると理不尽なので、胴体側の6×6(half f(3),f(3))を採る。
  [TILE16_ENEMY_HOPPER, { hw: f(3), hh: f(3) }],
  // TILE16_ENEMY_SANDWORM: 再生成後のアート実測 bbox4×9(x6-9,y4-12。縦に積んだ蛇腹)。
  // 旧アート(16×16)向けの12×12は絵の3倍の幅になるため、4×8(half f(2),f(4))へ縮める。
  [TILE16_ENEMY_SANDWORM, { hw: f(2), hh: f(4) }],
  // TILE16_ENEMY_SIDECAR: 再生成後のアート実測 bbox10×10(x3-12,y3-12。片側に張り出した座席)。
  // 8×8(half f(4),f(4))を採る。
  [TILE16_ENEMY_SIDECAR, { hw: f(4), hh: f(4) }],
  // TILE16_ENEMY_MOTHER: アート実測 bbox14×16/芯14×16 に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_MOTHER, { hw: f(6), hh: f(6) }],
  // TILE16_ENEMY_MIRAGE: アート実測 bbox16×16/芯16×16 に対し12×12(half f(6),f(6))を採る。
  [TILE16_ENEMY_MIRAGE, { hw: f(6), hh: f(6) }],
  // TILE16_ENEMY_CHASER: アート実測 bbox8×16/芯6×12 に対し6×10(half f(3),f(5))を採る。
  [TILE16_ENEMY_CHASER, { hw: f(3), hh: f(5) }],
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
