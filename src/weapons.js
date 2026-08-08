// weapons.js — 自機の3武器（発射・弾更新）。すべて8.8固定小数点整数のみで計算する。
import { f, toPx } from './fixed.js';
import { PLAYER_BULLETS, EFFECTS, spawn, forEach } from './entities.js';
import { TILE_BULLET_REVOLVER, TILE_BULLET_IRONBALL, TILE_BULLET_DYNAMITE } from './tiles.js';

// 武器ID。fire(weaponId, x, y) / game.js の武器サイクルで使う単純な数値マップ。
export const WEAPON = {
  REVOLVER: 0,
  IRONBALL: 1,
  DYNAMITE: 2,
};

export const WEAPON_NAMES = ['REVOLVER', 'IRONBALL', 'DYNAMITE'];

// flags bit0 = 貫通（鉄球のみ）
const FLAG_PIERCE = 1;

// 自弾専用タイル（tiles.js。最暗色index3で描かれ、背景から常に浮いて見える）
const BULLET_TILE_REVOLVER = TILE_BULLET_REVOLVER;
const BULLET_TILE_IRONBALL = TILE_BULLET_IRONBALL;
const BULLET_TILE_DYNAMITE = TILE_BULLET_DYNAMITE;
// ダイナマイトの着弾爆発は仮タイル(岩=4)を流用。専用爆発演出はStep5以降の対象範囲外。
const EFFECT_TILE_EXPLOSION = 4;

const IRONBALL_CURVE_ACCEL = 4; // 8.8固定小数点。毎フレーム vx に加算し弧を描かせる（ガンダム的湾曲の演出）
const DYNAMITE_GRAVITY = 16; // 8.8固定小数点。毎フレーム vy に加算し山なり軌道にする
const HIT_COOLDOWN_FRAMES = 8; // 鉄球が同一敵へ連続フレームでヒットしないためのクールダウン

const SCREEN_W = 160;
const SCREEN_H = 144;

// fire(weaponId, x, y): x,y は8.8固定小数点の発射座標。空きスロットが無ければ何もしない。
export function fire(weaponId, x, y) {
  const b = spawn(PLAYER_BULLETS);
  if (!b) {
    return false;
  }

  b.x = x;
  b.y = y;
  b.vx = 0;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = weaponId;
  b.lastHitEnemy = -1;
  b.hitCooldown = 0;

  if (weaponId === WEAPON.REVOLVER) {
    b.vy = -f(6);
    b.tile = BULLET_TILE_REVOLVER;
  } else if (weaponId === WEAPON.IRONBALL) {
    b.vy = -f(2);
    b.flags = FLAG_PIERCE;
    b.tile = BULLET_TILE_IRONBALL;
  } else {
    // DYNAMITE: 山なり。初速で打ち上げ、毎フレーム重力相当を加算して減速→落下させる
    b.vy = -f(3);
    b.tile = BULLET_TILE_DYNAMITE;
  }

  return true;
}

function spawnExplosion(x, y) {
  const e = spawn(EFFECTS);
  if (!e) {
    return;
  }
  e.x = x;
  e.y = y;
  e.vx = 0;
  e.vy = 0;
  e.hp = 0;
  e.flags = 1; // bit0 = 爆風判定あり（小範囲）
  e.timer = 0;
  e.kind = 0; // 0 = 爆発エフェクト種別
  e.tile = EFFECT_TILE_EXPLOSION;
  e.radius = f(10); // 小範囲の爆風半径（8.8固定小数点）
}

function isOffscreen(b) {
  const px = toPx(b.x);
  const py = toPx(b.y);
  return px < -16 || px > SCREEN_W || py < -16 || py > SCREEN_H;
}

// 1発分の更新（forEach へ渡す関数参照。毎フレーム新規クロージャを作らないよう関数は外で1回だけ定義する）
function updateOneBullet(b) {
  if (b.kind === WEAPON.IRONBALL) {
    b.vx += IRONBALL_CURVE_ACCEL; // 横方向へわずかに加速して弧を描く
    if (b.hitCooldown > 0) {
      b.hitCooldown -= 1;
    }
  } else if (b.kind === WEAPON.DYNAMITE) {
    const wasNegative = b.vy < 0;
    b.vy += DYNAMITE_GRAVITY;
    if (wasNegative && b.vy >= 0) {
      // vy が正に転じた瞬間（山なりの頂点を過ぎた）= 着弾扱いで爆発して消える
      spawnExplosion(b.x, b.y);
      b.alive = false;
      return;
    }
  }

  b.x += b.vx;
  b.y += b.vy;

  if (isOffscreen(b)) {
    b.alive = false;
  }
}

export function updateBullets() {
  forEach(PLAYER_BULLETS, updateOneBullet);
}
