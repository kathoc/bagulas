// game.js — 自機・入力・当たり判定・スコア/残機/ゲームオーバーを含むゲームループ本体
// 8.8固定小数点のみ使用。毎フレームのオブジェクト/配列生成は禁止（update系関数内で new/{}/[]/push/map/filter は使わない）。
import { f, toPx, fmul } from './fixed.js';
import {
  hitOverlap,
  centerCoord,
  SPRITE_HALF_16,
  SPRITE_HALF_32,
  SPRITE_HALF_8,
  PLAYER_HITBOX,
  BOSS_HITBOX,
  PLAYER_BULLET_HITBOX,
  ENEMY_BULLET_HITBOX,
  enemyHitboxForTile,
  obstacleHitboxForTile,
} from './hitbox.js';
import { isDown, isPressed, K, isTouch } from './input.js';
import { pushMeta16, pushSprite, drawText, drawSolidRect, spriteBudgetLeft, isOffRoadAt } from './gfx.js';
import { TILE16_PLAYER, TILE_SMOKE } from './tiles.js';
import { PLAYER_BULLETS, ENEMIES, ENEMY_BULLETS, OBSTACLES, EFFECTS, SCORE_POPS, SMOKE, spawn, forEach, forEachFrom } from './entities.js';
import { fire, updateBullets, WEAPON, WEAPON_NAMES } from './weapons.js';
import {
  resetEnemies,
  updateEnemies,
  updateEnemyBullets,
  updateObstacles,
  drawEnemies,
  drawEnemyBullets,
  drawObstacles,
  damageEnemy,
  damageObstacle,
  ENEMY_EXPLOSION_TILES,
  EFFECT_KIND_ENEMY_EXPLOSION,
  isAtBossSection,
  clearEnemies,
  setLoop,
  getSectionIndex,
} from './enemies.js';
import { STAGES } from './stages.js';
import {
  startBoss,
  updateBoss,
  drawBoss,
  damageBoss,
  isBossActive,
  getBossHp,
  getBossX,
  getBossY,
} from './boss.js';

// 自機の可動範囲（画面px, 8.8化前の生値）。
// x: スプライト幅16pxのため右端は 160-16=144 まで。
// y: 下半分の走行レーンに制限（敵は上から出現させる想定のため自機はプレイエリア下側に固定）。
//    上限は中央よりやや下の64、下限はスプライト高16pxを考慮した画面下端128。
const X_MIN = 0;
const X_MAX = 144;
const Y_MIN = 64;
const Y_MAX = 128;

const PLAYER_SPEED = f(2); // 1フレームあたり2px。慣性なし・キー押下中のみ一定速度で移動する
// オフロード時の速度係数 2/3 ≈ 0x00AB(171/256)。0x0155(341/256)は逆方向(4/3倍)なので使わない。
const PLAYER_SPEED_OFFROAD = fmul(PLAYER_SPEED, 0x00ab); // 定数同士なのでモジュール初期化時に1回だけ計算

const EFFECT_DURATION = 12; // エフェクト（爆発等）の表示フレーム数
const EXPLOSION_TILE_SWAP_INTERVAL = 4; // 敵撃破爆発のtile差し替え間隔(フレーム)
const SCORE_POP_DURATION = 30; // スコアポップの表示フレーム数

const START_LIVES = 3;
const PLAYER_INVULN_FRAMES = 180; // 被弾後(リスポーン後)の無敵フレーム数。3秒(180フレーム)
const PLAYER_BLINK_INTERVAL = 3; // 無敵中の点滅周期(フレーム)

const SHAKE_PERIOD_SHIFT = 3; // オフロード揺れの周期。distance(またはcurDistance)をこのbit分右シフトしてから&1する
const SMOKE_LIFETIME = 14; // 煙の寿命(フレーム)
const SMOKE_VY = 96; // 下方向への流れ速度(8.8固定小数点、約96/256px/frame)
const SMOKE_SPAWN_INTERVAL = 6; // オフロード中、この間隔(フレーム)で1個ずつ交互に左右へ生成する

// --- 自機死亡と復活（スクロール減速→停止→再加速） ---
// main.js旧ローカル定数の移設先。main.jsはgetScrollSpeed()で毎フレーム取得するだけになる。
const SCROLL_SPEED_BASE = 0x0100; // 通常時のスクロール速度(8.8固定小数点、1px/frame)
const SCROLL_DECEL_STEP = 8; // 死亡演出中、毎フレーム線形に減速させる量(8.8固定小数点)
const SCROLL_ACCEL_STEP = 8; // リスポーン後、毎フレーム線形に加速させる量(8.8固定小数点)
// オフロード時のスクロール係数 2/3 ≈ 0x00AB(171/256)。検算: fmul(256,171)は(256*171)>>8=171。
// 0x0155(341/256)は逆に4/3倍になるので絶対に使わない。
const SCROLL_OFFROAD_FACTOR = 0x00ab;
const DEATH = { NONE: 0, DYING: 1, RESPAWNING: 2 };

const CLEAR_DISPLAY_FRAMES = 90; // CLEARテキストを表示してから次ステージへ進むまでのフレーム数

// HUD背景帯: 4pxフォント化に伴いSCORE/LIVES/武器名/BOSS HPを1行(y=1、高さ8px)へ集約。
// 上下1pxずつ余白を取った高さぶんだけ覆う。最暗色(3)で背景から浮かせる
const HUD_BAND_HEIGHT = 10;
const HUD_BAND_COLOR = 3;
const HUD_TEXT_Y = 1;

export const STATE = { TITLE: 0, PLAY: 1, BOSS: 2, CLEAR: 3, GAMEOVER: 4 };

let playerX = 0; // 8.8固定小数点
let playerY = 0; // 8.8固定小数点
let score = 0;
let lives = START_LIVES;
let weaponIndex = 0; // WEAPON.REVOLVER/IRONBALL/DYNAMITE のインデックス
let paused = false;
let distance = 0; // 進行距離。main.jsは変更しないためgame.js側で1px/frame分プレーンintで管理する
let gameState = STATE.TITLE;

let stageIndex = 0; // 0-based。M1ではSTAGES[0]のみ実プレイ可能
let loop = 0; // 全6面を1周するたびに+1
let clearTimer = 0; // CLEAR表示の残フレーム

let playerInvuln = 0; // 残り無敵フレーム
let playerOffRoad = false; // 直近フレームでオフロード判定だったか（速度2/3・揺れ・煙に使用。毎フレーム再計算）
let shotCooldown = 0; // オート連射のクールダウン残フレーム（5フレームで秒間約12発）

// 自機死亡と復活の状態機械。DYING中は自機を描かず入力も受け付けない。
// RESPAWNING中はスクロールが加速で戻りつつ、自機は無敵点滅で操作可能。
let deathState = DEATH.NONE;
let scrollRamp = SCROLL_SPEED_BASE; // 8.8固定小数点。死亡/復活の権威値。main.jsはgetScrollSpeed()経由で読むだけ

// M1で実プレイ可能なのはstageIndex===0（荒野）のみ。他は骨組みデータのみのプレースホルダー。
function isStagePlayable(idx) {
  return idx === 0;
}

function resetPlayerState() {
  playerX = f(72);
  playerY = f(Y_MAX);
  paused = false;
  playerInvuln = 0;
  playerOffRoad = false;
  shotCooldown = 0;
  deathState = DEATH.NONE;
  scrollRamp = SCROLL_SPEED_BASE;
}

// main.jsから毎フレーム呼ばれる（main.jsのループ制御自体は変更しない。速度の取得方法だけがここに移る）。
// scrollRamp(死亡/復活の権威値)に、直近フレームのplayerOffRoad判定によるオフロード係数を合成して返す。
// 両者は独立に効く: dying中はrampが0まで落ちるので係数に関わらず必ず0になり、
// 復帰後(ramp=SCROLL_SPEED_BASE)にオンロードなら必ずSCROLL_SPEED_BASEそのものへ戻る。
export function getScrollSpeed() {
  return fmul(scrollRamp, playerOffRoad ? SCROLL_OFFROAD_FACTOR : 0x0100);
}

// idxのステージを読み込む。実プレイ可能ならPLAYへ、そうでなければCLEAR表示を挟んで素通りする
// （advanceStageが次のisStagePlayableなステージまで自動でカスケードする）。
function loadStage(idx) {
  distance = 0;
  if (isStagePlayable(idx)) {
    resetPlayerState();
    setLoop(loop);
    resetEnemies();
    gameState = STATE.PLAY;
  } else {
    clearTimer = CLEAR_DISPLAY_FRAMES;
    gameState = STATE.CLEAR;
  }
}

// TITLE/GAMEOVERからの(再)開始。stageIndex/loopもここでリセットする。
function startRun() {
  score = 0;
  lives = START_LIVES;
  weaponIndex = WEAPON.REVOLVER;
  stageIndex = 0;
  loop = 0;
  loadStage(0);
}

export function initGame() {
  gameState = STATE.TITLE;
  score = 0;
  lives = START_LIVES;
  weaponIndex = WEAPON.REVOLVER;
  stageIndex = 0;
  loop = 0;
  distance = 0;
  resetPlayerState();
  resetEnemies();
}

export function getState() {
  return gameState;
}

function clamp(v, lo, hi) {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
}

// forEach へ渡す関数参照はモジュール直下で1回だけ定義する（毎フレーム新規クロージャを作らないため）
function ageEffect(e) {
  e.timer += 1;
  e.x += e.vx;
  e.y += e.vy;

  // 敵/障害物撃破の爆発は数フレームごとにtileを差し替えて2〜3パターンのアニメにする
  if (e.kind === EFFECT_KIND_ENEMY_EXPLOSION) {
    const step = (e.timer / EXPLOSION_TILE_SWAP_INTERVAL) | 0;
    e.tile = ENEMY_EXPLOSION_TILES[step % ENEMY_EXPLOSION_TILES.length];
  }

  if (e.timer > EFFECT_DURATION) {
    e.alive = false;
  }
}

function ageScorePop(p) {
  p.timer += 1;
  p.y += p.vy;
  if (p.timer > SCORE_POP_DURATION) {
    p.alive = false;
  }
}

// オフロード煙: 毎フレーム下方向へ流し、寿命が尽きたら消す。
function ageSmoke(s) {
  s.timer += 1;
  s.y += s.vy;
  if (s.timer > SMOKE_LIFETIME) {
    s.alive = false;
  }
}

// オフロード煙を1個確保して(px,py)から下方向へ流れ始めさせる。プール満杯なら諦める
// （煙はスプライト予算/プール枠が逼迫したときに最初に諦めてよい最低優先度の演出のため）。
function spawnSmoke(px, py) {
  const s = spawn(SMOKE);
  if (!s) {
    return;
  }
  s.x = f(px);
  s.y = f(py);
  s.vy = SMOKE_VY;
  s.timer = 0;
  s.tile = TILE_SMOKE;
}

// オフロード判定を毎フレーム位置から再計算する（慣性なしで即座に復帰させるため状態を持ち越さない）。
function updatePlayerOffRoad(scrollY) {
  const centerPx = toPx(playerX) + 8;
  playerOffRoad = isOffRoadAt(scrollY, centerPx, toPx(playerY) + 16); // 自機16x16の足元(下端)の行を参照
}

function updatePlayerMove(scrollY) {
  updatePlayerOffRoad(scrollY);
  const speed = playerOffRoad ? PLAYER_SPEED_OFFROAD : PLAYER_SPEED;
  if (isDown(K.LEFT)) {
    playerX -= speed;
  }
  if (isDown(K.RIGHT)) {
    playerX += speed;
  }
  if (isDown(K.UP)) {
    playerY -= speed;
  }
  if (isDown(K.DOWN)) {
    playerY += speed;
  }
  playerX = clamp(playerX, f(X_MIN), f(X_MAX));
  playerY = clamp(playerY, f(Y_MIN), f(Y_MAX));
}

// 自機の爆発エフェクトを1個確保する。enemies.jsのspawnEnemyExplosion()と同じ見た目(小→大→散の
// 3パターン)をEFFECTSプール経由で流用する(kind/tileの意味はenemies.js側の定義と共通)。
function spawnPlayerDeathExplosion() {
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = playerX;
  eff.y = playerY;
  eff.vx = 0;
  eff.vy = 0;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_ENEMY_EXPLOSION;
  eff.tile = ENEMY_EXPLOSION_TILES[0];
  eff.radius = 0;
}

// 被弾死亡時の共通処理: 爆発エフェクトを出し、死亡演出(DYING)へ入る。
// 実際の残機減算とスクロール減速→停止→(リスポーン/ゲームオーバー)分岐はupdateScrollSpeed()側で行う。
// 死亡演出中/リスポーン加速中の再ヒットは無視する(多重死亡防止)。
function hurtPlayer(fromX, fromY) {
  if (deathState !== DEATH.NONE) {
    return;
  }
  lives -= 1;
  if (lives < 0) {
    lives = 0;
  }
  spawnPlayerDeathExplosion();
  deathState = DEATH.DYING;
  // 死亡演出中は無敵扱い(collidePlayerVsWorldは既存のplayerInvuln>0チェックでスキップされる)。
  playerInvuln = 0x7fffffff; // 演出中は自機を描画・判定しないための大きな値(collidePlayerVsWorldをスキップさせる)
}

// スクロール速度の状態機械。DYING: 線形減速→0で停止(lives<=0ならGAMEOVERへ、それ以外はリスポーン開始)。
// RESPAWNING: 線形加速→SCROLL_SPEED_BASEに達したら通常状態(NONE)へ戻る。
function beginRespawn() {
  deathState = DEATH.RESPAWNING;
  playerX = f(72);
  playerY = f(Y_MAX);
  playerInvuln = PLAYER_INVULN_FRAMES; // 3秒(180フレーム)、点滅で無敵を明示
}

function updateScrollSpeed() {
  if (deathState === DEATH.DYING) {
    scrollRamp -= SCROLL_DECEL_STEP;
    if (scrollRamp <= 0) {
      scrollRamp = 0;
      if (lives <= 0) {
        deathState = DEATH.NONE;
        gameState = STATE.GAMEOVER;
      } else {
        beginRespawn();
      }
    }
  } else if (deathState === DEATH.RESPAWNING) {
    scrollRamp += SCROLL_ACCEL_STEP;
    if (scrollRamp >= SCROLL_SPEED_BASE) {
      scrollRamp = SCROLL_SPEED_BASE;
      deathState = DEATH.NONE;
    }
  }
}

// 二重ループの当たり判定はいずれも「外側forEachのコールバックが現在の要素をモジュール変数へ保持し、
// 内側forEachへは使い回しの関数参照だけを渡す」形にする。forEach(pool, (x)=>...) のようなアロー関数を
// 直接渡すと、外側forEachが回るたびに新しいクロージャが生成されてしまうため使わない。
let curBullet = null;
let curEffect = null;

const HIT_COOLDOWN_FRAMES = 8; // 鉄球が同一敵へ連続ヒットしないためのクールダウン(weapons.js既存値と同じ運用)
const FLAG_PIERCE = 1;

function checkOneEnemyAgainstCurBullet(e, idx) {
  if (!curBullet.alive || !e.alive) {
    return;
  }
  const pierce = (curBullet.flags & FLAG_PIERCE) !== 0;
  // 鉄球(貫通)は直前に当てた同一敵への連続ヒットのみクールダウンで防ぐ。別の敵には即ヒットできる。
  if (pierce && curBullet.lastHitEnemy === idx && curBullet.hitCooldown > 0) {
    return;
  }
  const eb = enemyHitboxForTile(e.tile);
  const hit = hitOverlap(
    centerCoord(curBullet.x, SPRITE_HALF_8),
    centerCoord(curBullet.y, SPRITE_HALF_8),
    PLAYER_BULLET_HITBOX.hw,
    PLAYER_BULLET_HITBOX.hh,
    centerCoord(e.x, SPRITE_HALF_16),
    centerCoord(e.y, SPRITE_HALF_16),
    eb.hw,
    eb.hh
  );
  if (!hit) {
    return;
  }
  score += damageEnemy(e, 1);
  if (pierce) {
    curBullet.lastHitEnemy = idx;
    curBullet.hitCooldown = HIT_COOLDOWN_FRAMES;
  } else {
    curBullet.alive = false;
  }
}

function checkBulletVsEnemies(b) {
  curBullet = b;
  forEach(ENEMIES, checkOneEnemyAgainstCurBullet);
}

// PLAYER_BULLETS × ENEMIES の当たり判定。生成物なし・既存プールのforEachのみ使用（二重ループ）。
function collideBulletsVsEnemies() {
  forEach(PLAYER_BULLETS, checkBulletVsEnemies);
}

function checkOneObstacleAgainstCurBullet(o) {
  if (!curBullet.alive || !o.alive) {
    return;
  }
  const ob = obstacleHitboxForTile(o.tile);
  const hit = hitOverlap(
    centerCoord(curBullet.x, SPRITE_HALF_8),
    centerCoord(curBullet.y, SPRITE_HALF_8),
    PLAYER_BULLET_HITBOX.hw,
    PLAYER_BULLET_HITBOX.hh,
    centerCoord(o.x, SPRITE_HALF_16),
    centerCoord(o.y, SPRITE_HALF_16),
    ob.hw,
    ob.hh
  );
  if (!hit) {
    return;
  }
  // 決定事項: 鉄球(貫通)であっても障害物（岩・柵・サボテン）は貫通しない。
  // 弾は障害物との接触で必ず消える。破壊可なら1ダメージを与える。
  score += damageObstacle(o, 1);
  curBullet.alive = false;
}

function checkBulletVsObstacles(b) {
  curBullet = b;
  forEach(OBSTACLES, checkOneObstacleAgainstCurBullet);
}

// PLAYER_BULLETS × OBSTACLES(破壊可)の当たり判定。
function collideBulletsVsObstacles() {
  forEach(PLAYER_BULLETS, checkBulletVsObstacles);
}

// ダイナマイトの爆風判定。EFFECTS.flags bit0 = 「未処理の爆風判定あり」(weapons.jsが設定)。
// 1回処理したらbitを落として以降のフレームで再ヒットさせない。
function checkOneEnemyAgainstCurExplosion(e) {
  if (!e.alive) {
    return;
  }
  const dx = e.x - curEffect.x;
  const dy = e.y - curEffect.y;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  if (ax <= curEffect.radius && ay <= curEffect.radius) {
    score += damageEnemy(e, 2);
  }
}

function checkOneObstacleAgainstCurExplosion(o) {
  if (!o.alive) {
    return;
  }
  const dx = o.x - curEffect.x;
  const dy = o.y - curEffect.y;
  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  if (ax <= curEffect.radius && ay <= curEffect.radius) {
    score += damageObstacle(o, 2);
  }
}

function checkExplosionEffect(e) {
  if (!e.alive || (e.flags & 1) === 0 || e.radius <= 0) {
    return;
  }
  curEffect = e;
  forEach(ENEMIES, checkOneEnemyAgainstCurExplosion);
  forEach(OBSTACLES, checkOneObstacleAgainstCurExplosion);
  e.flags &= ~1; // 判定済み。以降のフレームでは再ヒットさせない
}

function collideExplosionsVsTargets() {
  forEach(EFFECTS, checkExplosionEffect);
}

// 敵/敵弾/障害物 × 自機。自機の無敵タイマー中は判定をスキップする。
function checkEnemyVsPlayer(e) {
  if (playerInvuln > 0 || !e.alive) {
    return;
  }
  const eb = enemyHitboxForTile(e.tile);
  const hit = hitOverlap(
    centerCoord(playerX, SPRITE_HALF_16),
    centerCoord(playerY, SPRITE_HALF_16),
    PLAYER_HITBOX.hw,
    PLAYER_HITBOX.hh,
    centerCoord(e.x, SPRITE_HALF_16),
    centerCoord(e.y, SPRITE_HALF_16),
    eb.hw,
    eb.hh
  );
  if (hit) {
    hurtPlayer(e.x, e.y);
  }
}

function checkEnemyBulletVsPlayer(b) {
  if (playerInvuln > 0 || !b.alive) {
    return;
  }
  const hit = hitOverlap(
    centerCoord(playerX, SPRITE_HALF_16),
    centerCoord(playerY, SPRITE_HALF_16),
    PLAYER_HITBOX.hw,
    PLAYER_HITBOX.hh,
    centerCoord(b.x, SPRITE_HALF_8),
    centerCoord(b.y, SPRITE_HALF_8),
    ENEMY_BULLET_HITBOX.hw,
    ENEMY_BULLET_HITBOX.hh
  );
  if (hit) {
    b.alive = false;
    hurtPlayer(b.x, b.y);
  }
}

function checkObstacleVsPlayer(o) {
  if (playerInvuln > 0 || !o.alive) {
    return;
  }
  const ob = obstacleHitboxForTile(o.tile);
  const hit = hitOverlap(
    centerCoord(playerX, SPRITE_HALF_16),
    centerCoord(playerY, SPRITE_HALF_16),
    PLAYER_HITBOX.hw,
    PLAYER_HITBOX.hh,
    centerCoord(o.x, SPRITE_HALF_16),
    centerCoord(o.y, SPRITE_HALF_16),
    ob.hw,
    ob.hh
  );
  if (hit) {
    hurtPlayer(o.x, o.y);
  }
}

function collidePlayerVsWorld() {
  if (playerInvuln > 0) {
    return; // 判定自体を丸ごとスキップ（forEachのオーバーヘッドも避ける）
  }
  forEach(ENEMIES, checkEnemyVsPlayer);
  forEach(ENEMY_BULLETS, checkEnemyBulletVsPlayer);
  forEach(OBSTACLES, checkObstacleVsPlayer);
}

// ボス戦での「直前に当てた対象」センチネル値。鉄球(貫通)の連続ヒット防止に使う
// PLAYER_BULLETS.lastHitEnemy フィールド（通常はENEMIESプールのindexが入る）を流用し、
// 新規フィールドは追加しない。敵プールindexは0以上のため負値なら衝突しない。
const BOSS_HIT_SENTINEL = -2;

function checkBulletVsBoss(b) {
  if (!b.alive || !isBossActive()) {
    return;
  }
  const pierce = (b.flags & FLAG_PIERCE) !== 0;
  if (pierce && b.lastHitEnemy === BOSS_HIT_SENTINEL && b.hitCooldown > 0) {
    return;
  }
  const hit = hitOverlap(
    centerCoord(b.x, SPRITE_HALF_8),
    centerCoord(b.y, SPRITE_HALF_8),
    PLAYER_BULLET_HITBOX.hw,
    PLAYER_BULLET_HITBOX.hh,
    centerCoord(getBossX(), SPRITE_HALF_32),
    centerCoord(getBossY(), SPRITE_HALF_32),
    BOSS_HITBOX.hw,
    BOSS_HITBOX.hh
  );
  if (!hit) {
    return;
  }
  score += damageBoss(1);
  if (pierce) {
    b.lastHitEnemy = BOSS_HIT_SENTINEL;
    b.hitCooldown = HIT_COOLDOWN_FRAMES;
  } else {
    b.alive = false;
  }
}

// PLAYER_BULLETS × ボスAABBの当たり判定。checkOneEnemyAgainstCurBulletの貫通/クールダウン処理を
// ボス単体向けに再実装したもの（相手が1体固定なのでforEachの二重ループは不要）。
function collideBulletsVsBoss() {
  forEach(PLAYER_BULLETS, checkBulletVsBoss);
}

// ボス本体 × 自機の接触ダメージ。checkEnemyVsPlayerのボス版。
function checkBossVsPlayer() {
  if (playerInvuln > 0 || !isBossActive()) {
    return;
  }
  const hit = hitOverlap(
    centerCoord(playerX, SPRITE_HALF_16),
    centerCoord(playerY, SPRITE_HALF_16),
    PLAYER_HITBOX.hw,
    PLAYER_HITBOX.hh,
    centerCoord(getBossX(), SPRITE_HALF_32),
    centerCoord(getBossY(), SPRITE_HALF_32),
    BOSS_HITBOX.hw,
    BOSS_HITBOX.hh
  );
  if (hit) {
    hurtPlayer(getBossX(), getBossY());
  }
}

function killObstacleSlot(o) {
  o.alive = false;
}

// TITLE/GAMEOVERからの入力トリガのみ判定する共通処理。
// PLAY/BOSSで共有する自機側の毎フレーム処理（移動・無敵減算・武器サイクル・射撃・自弾更新）。
// 死亡演出中(DYING)は入力を一切受け付けず、既存の自弾だけ動かし続ける（新規発射はしない）。
// distanceも死亡演出中は進めない(スポーンテーブルのカーソルが一気に飛ばないようにするため)。
function updatePlayerCommon(scrollY) {
  if (deathState === DEATH.DYING) {
    updateBullets();
    return;
  }

  distance += 1;

  updatePlayerMove(scrollY);
  // オフロード中は左右交互にSMOKE_SPAWN_INTERVALフレームごとに煙を1個ずつ生成する。
  if (playerOffRoad && distance % SMOKE_SPAWN_INTERVAL === 0) {
    const side = ((distance / SMOKE_SPAWN_INTERVAL) | 0) & 1; // 0=左, 1=右 交互
    const smokeX = side === 0 ? toPx(playerX) - 4 : toPx(playerX) + 12;
    spawnSmoke(smokeX, toPx(playerY) + 8);
  }
  if (playerInvuln > 0) {
    playerInvuln -= 1;
  }

  // 武器サイクル: X/K のトリガのみ（押しっぱなし連射にはしない）
  if (isPressed(K.B)) {
    weaponIndex = (weaponIndex + 1) % WEAPON_NAMES.length;
  }

  // ショット: Z/J は押しっぱなしでオート連射（5フレームクールダウン=秒間約12発）。
  // 画面内2発制限は維持: fire()がpool満杯でfalseを返した場合はクールダウンを消費せず、
  // 次フレームで即座に空きを再チェックする（=「次の空きで撃つ」要件）。
  if (shotCooldown > 0) {
    shotCooldown -= 1;
  }
  if (isDown(K.A) && shotCooldown <= 0) {
    // 自機16x16の上端中央あたりから発射する
    const fired = fire(weaponIndex, playerX + f(6), playerY);
    if (fired) {
      shotCooldown = 5;
    }
  }

  updateBullets();
}

// stageIndexを進める。全ステージを一周したらstageIndexを0に戻しloopを+1する。
function advanceStage() {
  stageIndex += 1;
  if (stageIndex >= STAGES.length) {
    stageIndex = 0;
    loop += 1;
  }
  loadStage(stageIndex);
}

// デバッグ用の読み取り専用フック(window.__bagulas)。純粋な観測のみが目的で、
// ゲームロジックの側からこのオブジェクトを読み返すことは一切ない(一方向の書き出しのみ)。
function updateDebugHook() {
  if (typeof window === 'undefined') {
    return;
  }
  if (!window.__bagulas) {
    window.__bagulas = {};
  }
  const hook = window.__bagulas;
  hook.state = gameState;
  hook.stageIndex = stageIndex;
  hook.sectionIndex = getSectionIndex();
  hook.loop = loop;
  hook.score = score;
  hook.lives = lives;
  hook.bossHp = isBossActive() ? getBossHp() : null;
  hook.scrollSpeed = getScrollSpeed(); // 実際にmain.jsのループが消費する値(offroad係数込み)
  hook.scrollRamp = scrollRamp; // 死亡/復活の権威値(offroad係数を含まない生のランプ)
  hook.deathState = deathState;
}

export function updateGame(scrollY) {
  updateDebugHook(); // 毎フレーム更新。観測のみでロジックへは一切フィードバックしない

  if (gameState === STATE.GAMEOVER) {
    // リスタートはstartRun()経由でscore/lives以外にstageIndex/loopもリセットする
    if (isPressed(K.START)) {
      startRun();
    }
    return;
  }

  if (gameState === STATE.TITLE) {
    if (isPressed(K.START)) {
      startRun();
    }
    return; // TITLE中は自機移動・物理を一切行わない
  }

  if (gameState === STATE.CLEAR) {
    clearTimer -= 1;
    if (clearTimer <= 0) {
      advanceStage();
    }
    return; // CLEAR中はプレイヤー側ロジックを行わない
  }

  // 以降 PLAY / BOSS 共通: ポーズ切替はポーズ中でも判定する（Enterトリガのみ）
  if (isPressed(K.START)) {
    paused = !paused;
  }
  if (paused) {
    return;
  }

  updateScrollSpeed(); // 死亡演出中の減速/リスポーン中の加速を進める。GAMEOVERへ遷移することがある
  if (gameState === STATE.GAMEOVER) {
    return; // 死亡演出の減速がGAMEOVERへ遷移させた場合はここで打ち切る
  }

  updatePlayerCommon(scrollY);

  if (gameState === STATE.PLAY) {
    // 死亡演出中(DYING)は敵の速度をスクロール速度比でスケールし、スポーン/発射を止める。
    // ratioはscrollRamp(死亡/復活の権威値)のみから求める。offroad係数はここに混ぜない
    // （個々の敵は自分自身のe.offRoadで別途2/3を掛けるため、世界全体を二重に遅くしない）。
    // 8.8固定小数点(256=等倍)。整数除算のみ、Math.floorは使わずbit演算(|0)で整数化する。
    const ratio = ((scrollRamp << 8) / SCROLL_SPEED_BASE) | 0;
    const spawnFrozen = deathState === DEATH.DYING;
    updateEnemies(distance, playerX, playerY, scrollY, ratio, spawnFrozen);
    updateEnemyBullets();
    // 障害物は背景スクロールそのもの(offroad係数込みの実際の値)に完全追従させる。
    updateObstacles(distance, getScrollSpeed());

    collideBulletsVsEnemies();
    collideBulletsVsObstacles();
    collideExplosionsVsTargets();
    collidePlayerVsWorld();

    if (isAtBossSection()) {
      // ボス戦へ遷移。残存ゾコ敵/障害物を一括消去してスプライト/スキャンライン枠をボス用に空ける
      clearEnemies();
      forEach(OBSTACLES, killObstacleSlot);
      startBoss(loop);
      gameState = STATE.BOSS;
    }
  } else if (gameState === STATE.BOSS) {
    updateBoss(playerX, playerY);
    updateEnemyBullets(); // ボス弾もENEMY_BULLETSプールを再利用するため既存の更新関数で動く

    collideBulletsVsBoss();
    checkBossVsPlayer();
    forEach(ENEMY_BULLETS, checkEnemyBulletVsPlayer);

    if (!isBossActive()) {
      // 撃破演出が完了した（damageBoss()が返したスコアはヒット時点でscoreへ加算済み）
      clearTimer = CLEAR_DISPLAY_FRAMES;
      gameState = STATE.CLEAR;
    }
  }

  forEach(EFFECTS, ageEffect);
  forEach(SCORE_POPS, ageScorePop);
  forEach(SMOKE, ageSmoke);
}

// 優先度7(最後)。消えてよいのは自弾だけ、という仕様上ここが最も枠を失いやすい位置になる。
// 巡回順(forEachFrom)で毎フレーム開始位置をずらし、同じ弾だけが消え続けないようにする。
function drawBullet(b) {
  if (pushSprite(toPx(b.x), toPx(b.y), b.tile, 0)) {
    b.lastDrawnFrame = distance;
  }
}

// 優先度5(敵/障害物の次、砂煙より上)。
function drawEffect(e) {
  let drawn;
  if (e.kind === EFFECT_KIND_ENEMY_EXPLOSION) {
    // 爆発は実素材(explosion.png)由来の16x16メタスプライト。pushMeta16はall-or-nothingで
    // スプライト40個/走査線10個の上限を自前で守るため、ここでの追加チェックは不要。
    drawn = pushMeta16(toPx(e.x), toPx(e.y), e.tile, 0, false);
  } else {
    drawn = pushSprite(toPx(e.x), toPx(e.y), e.tile, 0);
  }
  if (drawn) {
    e.lastDrawnFrame = distance;
  }
}

// スコアポップはdrawText(=raster().blitGlyph直書き)でスプライト枠を消費しないため、
// 優先順位付けの対象外(常に描かれる)。
function drawScorePop(p) {
  drawText(toPx(p.x), toPx(p.y), '' + p.value);
}

// 優先度6(敵弾・敵・障害物・エフェクトより下、自弾より上)。
// 煙は点滅しながら流れて見えるよう、偶数timerのフレームだけ描く。
// spriteBudgetLeft()>0のときだけ描き、予算が逼迫していれば真っ先に諦める。
function drawSmoke(s) {
  if ((s.timer & 1) === 0 && spriteBudgetLeft() > 0) {
    if (pushSprite(toPx(s.x), toPx(s.y), s.tile, 0)) {
      s.lastDrawnFrame = distance;
    }
  }
}

export function drawGame() {
  if (gameState === STATE.TITLE) {
    const title = 'BAGULAS';
    drawText(80 - title.length * 2, 60, title); // 4px等幅グリフなので中央寄せ
    const startMsg = isTouch() ? 'TAP START' : 'PRESS ENTER';
    drawText(80 - startMsg.length * 2, 76, startMsg); // 4px等幅グリフなので中央寄せ
    return;
  }

  if (gameState === STATE.CLEAR) {
    const clearMsg = 'STAGE CLEAR';
    drawText(80 - clearMsg.length * 2, 68, clearMsg); // 4px等幅グリフなので中央寄せ
    return;
  }

  // PLAY / BOSS: 自機を描く（無敵中はPLAYER_BLINK_INTERVALフレームごとに描画をスキップして点滅させる）
  // GAMEOVERでは自機/敵/弾は描かずテキストのみを表示する。
  if (gameState === STATE.PLAY || gameState === STATE.BOSS) {
    // 死亡演出中(DYING)は自機を一切描かない(爆発エフェクトのみ表示)。
    const showShip = deathState !== DEATH.DYING;
    const blinkSkip = showShip && playerInvuln > 0 && ((playerInvuln / PLAYER_BLINK_INTERVAL) | 0) % 2 === 0;
    // オフロード時の上下1pxガタガタ揺れ。描画のみのオフセットでplayerY自体は変更しない
    // （当たり判定はplayerYの生値を使うため、ここで揺らしても衝突判定には影響しない）。
    // SHAKE_PERIOD_SHIFTで周期を伸ばし(distanceのbit0ではなくbit3)、毎フレーム反転する激しい
    // 揺れ(30Hz)を控えめな周期(8フレームごと=約約4Hz)に落とす。振幅1pxは維持。
    const shakeY = playerOffRoad ? (((distance >> SHAKE_PERIOD_SHIFT) & 1) ? -1 : 1) : 0;
    if (showShip && !blinkSkip) {
      pushMeta16(toPx(playerX), toPx(playerY) + shakeY, TILE16_PLAYER, 0, false);
    }

    // スプライト超過時のちらつき対応(docs/spec.md「スプライト超過の扱い」)。
    // 優先順位: 自機 > 敵弾 > 敵 > 障害物 > エフェクト > 砂煙 > 自弾。枠が足りない時は
    // この順で下位から捨てる。同一優先度内はforEachFrom()でフレームごとに開始位置をずらし、
    // 「同じ個体だけが永久に消える」のを避ける(実機GBのちらつき相当)。
    drawEnemyBullets(); // 優先度2。BOSS中もボス弾はこのプール経由で描かれる
    if (gameState === STATE.PLAY) {
      drawEnemies(); // 優先度3
      // 障害物はdrawBGObject()でBG層に直接描き、スプライト枠(40/10)を一切消費しない。
      // よってここでの描画順自体はちらつき対策として無意味だが、仕様の優先順位どおりの位置に置く。
      drawObstacles(); // 優先度4
    } else {
      drawBoss(); // 優先度3相当(ボスは敵の一種として扱う)
    }
    forEachFrom(EFFECTS, distance, drawEffect); // 優先度5
    forEachFrom(SCORE_POPS, distance, drawScorePop); // スプライト枠を消費しないため優先順位の対象外

    // オフロード時の煙(8x8、自機の左下・右下から下方向へ流れて消える)。優先度6。
    if (gameState === STATE.PLAY) {
      forEachFrom(SMOKE, distance, drawSmoke);
    }

    // 優先度7(最後・最下位)。消えてよいのは自弾だけ、という仕様どおり最後に描く。
    forEachFrom(PLAYER_BULLETS, distance, drawBullet);

    // HUDの可読性確保: テキストの下に最暗色の帯を敷いてから描く（背景の道/荒野と混ざらないように）
    // 4pxフォント化でSCORE/LIVES/武器名を1行に収められるようになったため1行のみ描く。
    // BOSS HPはボス戦中だけ同じ行に追記する(160px=40文字ぶんの余裕があるため武器名は省かない)。
    drawSolidRect(0, 0, 160, HUD_BAND_HEIGHT, HUD_BAND_COLOR);
    let hud = 'SCORE ' + score + ' LIVES ' + lives + ' ' + WEAPON_NAMES[weaponIndex];
    if (gameState === STATE.BOSS) {
      hud += ' BOSS ' + getBossHp();
    }
    drawText(2, HUD_TEXT_Y, hud);

    if (paused) {
      const pauseMsg = 'PAUSE';
      drawText(80 - pauseMsg.length * 2, 68, pauseMsg); // 4px等幅グリフなので中央寄せ
    }
  }

  if (gameState === STATE.GAMEOVER) {
    const overMsg = 'GAME OVER';
    drawText(80 - overMsg.length * 2, 68, overMsg); // 4px等幅グリフなので中央寄せ
    const startMsg = isTouch() ? 'TAP START' : 'PRESS ENTER';
    drawText(80 - startMsg.length * 2, 80, startMsg); // 4px等幅グリフなので中央寄せ
  }
}

// デバッグ用フック（タッチ/キーボード入力の実機・自動テストで自機移動やショットを
// 外部から確認するためのもの。ロジックには一切影響しない読み取り専用の窓）。
if (typeof window !== 'undefined') {
  window.__bagulas = {
    getState: () => gameState,
    getPlayerPos: () => ({ x: toPx(playerX), y: toPx(playerY) }),
    getBulletCount: () => {
      let n = 0;
      forEach(PLAYER_BULLETS, () => {
        n += 1;
      });
      return n;
    },
  };
}
