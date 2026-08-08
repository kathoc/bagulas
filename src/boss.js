// boss.js — ステージ1 ライバルレーサー中ボス（Step4）
// 単一インスタンス（プールではない）。8.8固定小数点のみ使用。
// update系関数内での new/{}/[]/push/map/filter は禁止（モジュールロード時の1回限りの確保のみ許可）。
import { f, toPx, fmul, DIR16, aim16 } from './fixed.js';
import { ENEMIES, ENEMY_BULLETS, EFFECTS, spawn, forEach } from './entities.js';
import { pushMeta16, spriteBudgetLeft } from './gfx.js';
import { TILE16_BOSS_TL, TILE16_BOSS_TR, TILE16_BOSS_BL, TILE16_BOSS_BR } from './tiles.js';
import { applyLoop } from './stages.js';
import { ENEMY_BULLET_TILE, EFFECT_KIND_ENEMY_EXPLOSION, ENEMY_EXPLOSION_TILES } from './enemies.js';

export const BOSS_MAX_HP = 40;
export const BOSS_SCORE_VALUE = 3000;
export const BOSS_SIZE = f(32);

const BOSS_HIT_FLASH_FRAMES = 2; // 被弾時の白フラッシュ表示フレーム数（enemies.jsのHIT_FLASH_FRAMESと同値だが未エクスポートのためローカル定義）
const BOSS_DEATH_FRAMES = 32; // 撃破演出の合計フレーム数
const BOSS_EXPLOSION_INTERVAL = 8; // 撃破演出で爆発を発生させる間隔（4回×8フレーム=32フレーム）

const BOSS_DESCEND_VY = f(1); // 登場時に画面内へ降りてくる速度
const BOSS_HOVER_Y = f(16); // 降下が止まる高さ
const BOSS_WEAVE_SPEED = 96; // 左右移動の速度（8.8固定小数点、1フレームあたり）
const BOSS_X_MIN = f(8);
const BOSS_X_MAX = f(120);

const BOSS_PATTERN_A_DURATION = 220; // パターン0(扇状固定弾)の持続フレーム数
const BOSS_PATTERN_B_DURATION = 220; // パターン1(自機狙い連射)の持続フレーム数

const FAN_FIRE_INTERVAL = 50; // パターン0: 発射間隔
const AIM_BURST_INTERVAL = 70; // パターン1: バースト間隔
const AIM_BURST_SHOT_GAP = 8; // パターン1: バースト内の1発ごとの間隔
const AIM_BURST_SHOT_COUNT = 3; // パターン1: 1バーストの発射数

const TELEGRAPH_FRAMES = 16; // 発射の何フレーム前から構えモーションに入るか
const TELEGRAPH_BLINK_SHIFT = 2; // telegraph>>この値 & 1 で点滅を作る（enemies.jsと同じ運用）

const BOSS_BULLET_SPEED = 2; // 敵弾速度(px/frame、整数。enemies.jsのENEMY_BULLET_SPEEDと同値)

// パターン0: 扇状固定方向弾（下方向に3方向）。DIR16のindex。
const FAN_DIRS = [6, 8, 10];

// 撃破演出: 32x32ボディを4象限に分けた爆発オフセット（8.8固定小数点、モジュールロード時に1回だけ確保）
const BOSS_EXPLOSION_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: f(16), dy: 0 },
  { dx: 0, dy: f(16) },
  { dx: f(16), dy: f(16) },
];

// ボス単一インスタンス。モジュールロード時に1回だけ確保する（毎フレーム生成ではないので許容）。
const boss = {
  active: false, // ボス戦進行中
  dying: false, // 撃破演出中
  x: 0,
  y: 0, // 8.8固定小数点、32x32ボディの左上
  hp: 0,
  maxHp: 0,
  moveDir: 1, // -1/1 左右移動方向
  pattern: 0, // 0 or 1、現在の攻撃パターン
  patternTimer: 0, // 次のパターン切替までの残フレーム
  telegraph: 0, // >0 = 次弾発射までの残フレーム(点滅ウィンドウ)
  burstIndex: 0, // 自機狙い連射パターンで、現バースト内の発射済み数
  burstTimer: 0,
  flashTimer: 0, // 被弾フラッシュの残フレーム
  dyingTimer: 0, // 撃破演出の残フレーム
  explosionStep: 0, // 撃破演出で次に出す爆発の位置(0..3)
};

let started = false; // startBoss()が一度でも呼ばれたか。isBossDone()の判定に使う

function killEnemySlot(s) {
  s.alive = false;
}

function clampBoss(v, lo, hi) {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
}

export function startBoss(loop) {
  // ボス戦突入時に残ったゾコ敵を一括消去し、スプライト/スキャンライン枠をボス用に空ける
  forEach(ENEMIES, killEnemySlot);

  boss.active = true;
  boss.dying = false;
  boss.x = f(64);
  boss.y = f(-32);
  boss.hp = applyLoop(BOSS_MAX_HP, loop);
  boss.maxHp = boss.hp;
  boss.moveDir = 1;
  boss.pattern = 0;
  boss.patternTimer = BOSS_PATTERN_A_DURATION;
  boss.telegraph = 0;
  boss.burstIndex = 0;
  boss.burstTimer = FAN_FIRE_INTERVAL;
  boss.flashTimer = 0;
  boss.dyingTimer = 0;
  boss.explosionStep = 0;
  started = true;
}

function fireBulletDir(dirIdx) {
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return; // プール満杯。撃てなかった分は諦める(enemies.jsのfireEnemyBulletと同じ運用)
  }
  const dir = DIR16[dirIdx];
  b.dirIdx = dirIdx;
  b.x = boss.x + f(16);
  b.y = boss.y + f(24);
  b.vx = fmul(dir.dx, f(BOSS_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(BOSS_BULLET_SPEED));
  b.tile = ENEMY_BULLET_TILE;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = 0;
}

function fireFanVolley() {
  for (let i = 0; i < FAN_DIRS.length; i++) {
    fireBulletDir(FAN_DIRS[i]);
  }
}

function fireAimedShot(playerX, playerY) {
  const dirIdx = aim16(playerX - (boss.x + f(16)), playerY - (boss.y + f(16)));
  fireBulletDir(dirIdx);
}

// パターン0: 扇状固定方向弾。FAN_FIRE_INTERVALごとにTELEGRAPH_FRAMES構えてから3方向同時発射する。
function updatePattern0() {
  if (boss.telegraph > 0) {
    boss.telegraph -= 1;
    if (boss.telegraph === 0) {
      fireFanVolley();
      boss.burstTimer = FAN_FIRE_INTERVAL;
    }
    return;
  }
  boss.burstTimer -= 1;
  if (boss.burstTimer <= 0) {
    boss.telegraph = TELEGRAPH_FRAMES; // 発射は必ずこの構えの後(次フレーム以降)に行う
  }
}

// パターン1: 自機狙いaim16連射。AIM_BURST_INTERVALごとに構えてから、
// AIM_BURST_SHOT_GAPフレーム間隔でAIM_BURST_SHOT_COUNT発を撃つ(最初の1発のみ構えを伴う)。
function updatePattern1(playerX, playerY) {
  if (boss.telegraph > 0) {
    boss.telegraph -= 1;
    if (boss.telegraph === 0) {
      fireAimedShot(playerX, playerY);
      boss.burstIndex = 1;
      boss.burstTimer = AIM_BURST_SHOT_GAP;
    }
    return;
  }
  boss.burstTimer -= 1;
  if (boss.burstTimer > 0) {
    return;
  }
  if (boss.burstIndex > 0 && boss.burstIndex < AIM_BURST_SHOT_COUNT) {
    fireAimedShot(playerX, playerY);
    boss.burstIndex += 1;
    if (boss.burstIndex < AIM_BURST_SHOT_COUNT) {
      boss.burstTimer = AIM_BURST_SHOT_GAP;
    } else {
      boss.burstIndex = 0;
      boss.burstTimer = AIM_BURST_INTERVAL;
    }
  } else {
    boss.telegraph = TELEGRAPH_FRAMES;
  }
}

function switchPattern() {
  boss.pattern = boss.pattern === 0 ? 1 : 0;
  boss.telegraph = 0;
  if (boss.pattern === 0) {
    boss.patternTimer = BOSS_PATTERN_A_DURATION;
    boss.burstTimer = FAN_FIRE_INTERVAL;
  } else {
    boss.patternTimer = BOSS_PATTERN_B_DURATION;
    boss.burstIndex = 0;
    boss.burstTimer = AIM_BURST_INTERVAL;
  }
}

function spawnBossExplosionAt(step) {
  const off = BOSS_EXPLOSION_OFFSETS[step];
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = boss.x + off.dx;
  eff.y = boss.y + off.dy;
  eff.vx = 0;
  eff.vy = 0;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_ENEMY_EXPLOSION;
  eff.tile = ENEMY_EXPLOSION_TILES[0];
  eff.radius = 0;
}

function updateDying() {
  boss.dyingTimer -= 1;
  if (boss.explosionStep < 4 && boss.dyingTimer % BOSS_EXPLOSION_INTERVAL === 0) {
    spawnBossExplosionAt(boss.explosionStep);
    boss.explosionStep += 1;
  }
  if (boss.dyingTimer <= 0) {
    boss.active = false;
    boss.dying = false;
  }
}

export function updateBoss(playerX, playerY) {
  if (!boss.active) {
    return;
  }
  if (boss.dying) {
    updateDying();
    return;
  }

  if (boss.y < BOSS_HOVER_Y) {
    boss.y += BOSS_DESCEND_VY;
    if (boss.y > BOSS_HOVER_Y) {
      boss.y = BOSS_HOVER_Y;
    }
  } else {
    boss.x += boss.moveDir * BOSS_WEAVE_SPEED;
    boss.x = clampBoss(boss.x, BOSS_X_MIN, BOSS_X_MAX);
    if (boss.x <= BOSS_X_MIN || boss.x >= BOSS_X_MAX) {
      boss.moveDir = -boss.moveDir;
    }

    boss.patternTimer -= 1;
    if (boss.patternTimer <= 0) {
      switchPattern();
    }

    if (boss.pattern === 0) {
      updatePattern0();
    } else {
      updatePattern1(playerX, playerY);
    }
  }

  if (boss.flashTimer > 0) {
    boss.flashTimer -= 1;
  }
}

// damageBoss(dmg): ダメージを与え、HPが尽きたら撃破演出を開始しBOSS_SCORE_VALUEを返す。
// まだ生きている、またはすでに撃破演出中の場合は0を返す（enemies.jsのdamageEnemyと同じ契約）。
export function damageBoss(dmg) {
  boss.hp -= dmg;
  boss.flashTimer = BOSS_HIT_FLASH_FRAMES;
  if (boss.hp <= 0 && !boss.dying) {
    boss.dying = true;
    boss.dyingTimer = BOSS_DEATH_FRAMES;
    boss.explosionStep = 0;
    return BOSS_SCORE_VALUE;
  }
  return 0;
}

export function isBossActive() {
  return boss.active; // 撃破演出中もtrueのまま。演出終了時にfalseになる
}

export function isBossDone() {
  return started && !boss.active;
}

export function getBossHp() {
  return boss.hp;
}

export function getBossMaxHp() {
  return boss.maxHp;
}

export function getBossX() {
  return boss.x;
}

export function getBossY() {
  return boss.y;
}

export function drawBoss() {
  if (!boss.active) {
    return;
  }
  // 32x32の全体をall-or-nothingで描く。16消費できないフレームは何も描かない(欠けさせない)。
  if (spriteBudgetLeft() < 16) {
    return;
  }

  let palInvert = false;
  if (boss.flashTimer > 0) {
    palInvert = true;
  } else if (boss.telegraph > 0) {
    palInvert = ((boss.telegraph >> TELEGRAPH_BLINK_SHIFT) & 1) === 0;
  }

  // 実素材(boss_rival.png)は本物の32x32なので、4象限をそれぞれ専用タイルで描く。
  // 反転による使い回し(mirroring)はしない。
  const px = toPx(boss.x);
  const py = toPx(boss.y);
  pushMeta16(px, py, TILE16_BOSS_TL, 0, palInvert);
  pushMeta16(px + 16, py, TILE16_BOSS_TR, 0, palInvert);
  pushMeta16(px, py + 16, TILE16_BOSS_BL, 0, palInvert);
  pushMeta16(px + 16, py + 16, TILE16_BOSS_BR, 0, palInvert);
}
