// enemies.js — 敵編隊・敵弾・障害物のスポーン/更新/描画/被弾処理（Step3）
// 8.8固定小数点のみ使用。update系関数内での new/{}/[]/push/map/filter は禁止。
// 三角関数・Math.random・sqrt は使わない。
import { f, toPx, fmul, DIR16, aim16 } from './fixed.js';
import { rndRange } from './rng.js';
import {
  ENEMIES,
  ENEMY_BULLETS,
  OBSTACLES,
  EFFECTS,
  SCORE_POPS,
  spawn,
  forEach,
} from './entities.js';
import {
  pushMeta16,
  pushSprite,
  drawBGObject,
  spriteBudgetLeft,
  isOffRoadAt,
  SAFE_ONROAD_LEFT_PX,
  SAFE_ONROAD_RIGHT_PX,
} from './gfx.js';
import {
  TILE16_ENEMY_A,
  TILE16_ENEMY_B,
  TILE16_ROCK,
  TILE16_FENCE,
  TILE16_CACTUS,
  TILE16_EXPLOSION_0,
  TILE16_EXPLOSION_1,
  TILE16_EXPLOSION_2,
  TILE_BULLET_ENEMY,
} from './tiles.js';
import { STAGES, FORMATIONS, OBSTACLE_KINDS, applyLoop } from './stages.js';

// 敵種別（ENEMIES.kind に格納する内部enum。0=V, 1=COLUMN, 2=SNAKE）
const KIND_V = 0;
const KIND_COLUMN = 1;
const KIND_SNAKE = 2;

// EFFECTS.kind の使い分け（weapons.js の kind=0=ダイナマイト爆発と衝突しない値を使う）
export const EFFECT_KIND_ENEMY_EXPLOSION = 1; // 敵/障害物撃破の爆発
export const EFFECT_KIND_DEBRIS = 2; // 撃破時の破片パーティクル
// 爆発の複数パターン演出用タイル差し替え列（実素材 explosion.png 由来の16x16メタスプライト3枚。
// 小→大→散の順。boss.jsの撃破演出も同じ配列を流用する）
export const ENEMY_EXPLOSION_TILES = [TILE16_EXPLOSION_0, TILE16_EXPLOSION_1, TILE16_EXPLOSION_2];

// --- 敵の移動・発射チューニング値（すべて整数/8.8固定小数点） ---
const ENEMY_VY = 96; // 敵の下降速度。スクロール速度の1/2(128)以下に抑え、横移動を主な脅威として読ませる
const V_SPACING = f(16); // V字の左右オフセット単位。横への広がりを強める
const V_MAX_OFFSET = f(32); // waveBaseX(24..120px)から見て完全に画面外へ居座らない範囲でclamp
const V_Y_STEP = f(6); // V字の前後(見た目上の奥行き)ずらし単位
const COLUMN_Y_SPACING = f(20); // 縦列の初期縦間隔
const SNAKE_Y_SPACING = f(24); // 蛇行編隊の初期縦間隔
const SNAKE_STEP = 128; // 振れ幅2倍に合わせてstepも2倍にし、半周期フレーム数をほぼ維持する
const SNAKE_AMPLITUDE = f(40); // 蛇行の振れ幅。anchorXから±40pxで大きく横へ振る
const SNAKE_PHASE_STEP = 800; // 蛇行メンバー間の初期位相ずらし
const WAVE_X_MIN = 24; // 編隊アンカーxの最小値(px)
const WAVE_X_SPREAD = 97; // rndRangeに渡す範囲（0..96）

const FIRE_INTERVAL_BASE = 90; // 発射間隔の基本値(フレーム)
const FIRE_INTERVAL_JITTER = 40; // 発射間隔のばらつき幅
const TELEGRAPH_SLOWDOWN_FRAMES = 40; // 発射40フレーム前から先に減速し、その後20フレーム前から点滅する
const TELEGRAPH_SLOWDOWN_NUM = 0x0080; // 予備動作中の縦速度係数(1/2)。横蛇行は継続して予兆中も位置取りを見せる
const TELEGRAPH_FRAMES = 20; // 発射の何フレーム前からフラッシュ構えモーションに入るか
const TELEGRAPH_BLINK_SHIFT = 2; // atkTimer>>この値 & 1 で4フレーム周期の点滅を作る
const SHAKE_PERIOD_SHIFT = 3; // オフロード揺れの周期(game.jsのSHAKE_PERIOD_SHIFTと同じ値)。8フレームごとに反転

// オフロード時の速度係数 2/3 ≈ 0x00AB(171/256)。playerと同じ係数(game.jsのPLAYER_SPEED_OFFROADと同義)。
// e.vyは生成時に一度だけ設定される定数のため、オフロード判定時にvy自体を書き換えず、
// 移動量計算のたびにローカルで係数をかけて求める（onroad復帰時の巻き戻しが不要になる）。
const ENEMY_SPEED_OFFROAD_NUM = 0x00ab;
const ENEMY_BULLET_SPEED = 2; // 敵弾速度(px/frame、整数)
export const ENEMY_BULLET_TILE = TILE_BULLET_ENEMY; // 敵弾専用タイル(最暗色index3)。boss.jsも同じ弾タイルを流用する
const ENEMY_BULLET_FIXED_DIR = 8; // DIR16のindex8=真下
const ENEMY_FIRE_PROXIMITY = f(32); // 自機/敵の中心距離がx/yとも32px以内なら発射しない
const SPRITE_CENTER_OFFSET = f(8); // 16x16スプライトの中心。近距離発射抑止はヒットボックスではなく見た目中心で判定する

const OBSTACLE_HP = 3; // 破壊可障害物の耐久

const ENEMY_SCORE_VALUE = 100;
const OBSTACLE_SCORE_VALUE = 50;

const HIT_FLASH_FRAMES = 2; // 被弾時の白フラッシュ表示フレーム数

// --- モジュールスコープの進行状態（配列生成なしのプレーン変数。resetEnemies()で初期化） ---
let sectionIndex = 0; // 0=prelude, 1=main, 2=boss到達(以降何もしない)
let sectionStartDistance = 0; // 現在のセクションが始まった時点の絶対distance
let waveCursor = 0; // 現在セクション内で次にスポーンすべきwavesのindex
let obstacleCursor = 0; // 同様にobstaclesのindex
let waveMemberIndex = 0; // 現在スポーン中のwaveで、すでにスポーンした体数
let waveBaseX = 0; // 現在スポーン中のwaveのx基準(8.8)
let currentFormationId = 0;
let nextFormationId = 1;
let loop = 0; // 周回カウンタ。game.jsのloadStage(0)からsetLoop()で更新される

export function setLoop(n) {
  loop = n;
}

// updateEnemies()の引数を、毎フレームクロージャを作らずforEachコールバックへ渡すためのモジュール変数
let curPlayerX = 0;
let curPlayerY = 0;
let curScrollY = 0; // updateOneEnemy()のオフロード判定用（updateEnemiesが毎フレーム更新する）
let curDistance = 0; // drawOneEnemy()の揺れ演出の周期用（updateEnemiesが毎フレーム更新する）
// 自機死亡演出〜復活の間、世界全体が一緒にスローになって見えるための速度比。
// 8.8固定小数点(256=等倍)。game.js が (現在のscrollSpeed<<8)/基準値 | 0 で算出して渡す。
let curEnemySpeedRatio = 256;
// 死亡演出中(爆発〜スクロール停止まで)は敵のスポーンと発射を止める。game.jsから毎フレーム渡される。
let curSpawnFrozen = false;
// 障害物の今フレームの下降速度(8.8固定小数点)。現在のスクロール速度そのもの(game.js由来)を
// updateObstacles()が毎フレーム更新する。スクロールが止まれば障害物も止まる。
let curObstacleVy = 256;

function killSlot(s) {
  s.alive = false;
}

export function resetEnemies() {
  sectionIndex = 0;
  sectionStartDistance = 0;
  waveCursor = 0;
  obstacleCursor = 0;
  waveMemberIndex = 0;
  waveBaseX = 0;
  currentFormationId = 0;
  nextFormationId = 1;

  forEach(ENEMIES, killSlot);
  forEach(ENEMY_BULLETS, killSlot);
  forEach(OBSTACLES, killSlot);
}

// セクション境界を跨いだかどうかを判定して進める。updateEnemies/updateObstacles両方から
// 毎フレーム呼ばれるが、境界を跨いでいなければ何もしないため冪等（二重に呼んでも安全）。
function advanceSection(distance) {
  if (sectionIndex >= 2) {
    return; // ボスセクション到達済み。以降スポーンしない
  }
  const sections = STAGES[0].sections;
  let localDistance = distance - sectionStartDistance;
  while (sectionIndex < 2 && localDistance >= sections[sectionIndex].length) {
    sectionStartDistance += sections[sectionIndex].length;
    sectionIndex += 1;
    waveCursor = 0;
    obstacleCursor = 0;
    waveMemberIndex = 0;
    localDistance = distance - sectionStartDistance;
  }
}

function vHalfIndex(memberIndex) {
  return (memberIndex + 1) >> 1;
}

// V字編隊の左右オフセット（中心0, 以降左右交互に広がる。V_MAX_OFFSETでclamp）
function vOffsetX(memberIndex) {
  if (memberIndex === 0) {
    return 0;
  }
  const half = vHalfIndex(memberIndex);
  const sign = (memberIndex & 1) === 1 ? -1 : 1;
  let off = half * V_SPACING;
  if (off > V_MAX_OFFSET) {
    off = V_MAX_OFFSET;
  }
  return sign * off;
}

function initEnemyFromWave(e, wave, memberIndex) {
  e.hp = applyLoop(wave.hp, loop);
  e.flags = 0;
  e.atkTimer = FIRE_INTERVAL_BASE + rndRange(FIRE_INTERVAL_JITTER);
  e.formationId = currentFormationId;
  e.timer = 0;

  if (wave.formation === FORMATIONS.V) {
    e.kind = KIND_V;
    e.tile = TILE16_ENEMY_A; // 理由: バイク風の細身タイルはV字/蛇行の機敏な編隊に合う
    e.x = waveBaseX + vOffsetX(memberIndex);
    e.y = f(-16) - vHalfIndex(memberIndex) * V_Y_STEP;
    e.vx = 0;
    e.vy = ENEMY_VY;
  } else if (wave.formation === FORMATIONS.COLUMN) {
    e.kind = KIND_COLUMN;
    e.tile = TILE16_ENEMY_B; // 理由: 丸い車風の幅広タイルは縦列でどっしり進む見た目に合う
    e.x = waveBaseX;
    e.y = f(-16) - memberIndex * COLUMN_Y_SPACING;
    e.vx = 0;
    e.vy = ENEMY_VY;
  } else {
    // SNAKE
    e.kind = KIND_SNAKE;
    e.tile = TILE16_ENEMY_A; // V字と同じ機敏な見た目を流用
    e.x = waveBaseX;
    e.y = f(-16) - memberIndex * SNAKE_Y_SPACING;
    e.anchorX = waveBaseX; // 蛇行の振動中心x（専用フィールド）
    e.vx = 0; // SNAKEでは未使用
    e.vy = ENEMY_VY;
    e.timer = memberIndex * SNAKE_PHASE_STEP; // メンバー間で初期位相をずらし群れがバラける動きにする
  }
}

// 現在セクションのwavesを距離に応じて1体ずつスポーンする。
// スプライト予算/プール空きが足りない場合はcursorを進めずそのフレームは諦め、次フレームに再試行する
// （wave丸ごとスキップはしない。1体ずつ確保できた分だけ進める設計）。
function spawnPendingWave(distance) {
  if (sectionIndex >= 2) {
    return;
  }
  const section = STAGES[0].sections[sectionIndex];
  const waves = section.waves;
  const localDistance = distance - sectionStartDistance;

  while (waveCursor < waves.length && waves[waveCursor].at <= localDistance) {
    const wave = waves[waveCursor];

    if (waveMemberIndex === 0) {
      waveBaseX = f(WAVE_X_MIN + rndRange(WAVE_X_SPREAD));
      currentFormationId = nextFormationId;
      nextFormationId += 1;
    }

    while (waveMemberIndex < wave.count) {
      if (spriteBudgetLeft() < 4) {
        return; // 枠が足りない。cursorは進めずこのフレームはここで打ち切り、次フレームに再試行
      }
      const e = spawn(ENEMIES);
      if (!e) {
        return; // プール満杯。同様に次フレームへ持ち越す
      }
      initEnemyFromWave(e, wave, waveMemberIndex);
      waveMemberIndex += 1;
    }

    // wave丸ごとスポーンし終えたので次のwaveへ
    waveCursor += 1;
    waveMemberIndex = 0;
  }
}

function updateOneEnemy(e) {
  // 被弾フラッシュの残フレーム消化
  if (e.flashTimer > 0) {
    e.flashTimer -= 1;
  }

  if (e.kind === KIND_SNAKE) {
    const dir = e.flags & 1;
    if (dir === 0) {
      e.timer += SNAKE_STEP;
      if (e.timer >= SNAKE_AMPLITUDE) {
        e.flags |= 1;
      }
    } else {
      e.timer -= SNAKE_STEP;
      if (e.timer <= -SNAKE_AMPLITUDE) {
        e.flags &= ~1;
      }
    }
    e.x = e.anchorX + e.timer; // anchorXは振動中心x（初期化時に設定済み）
  }

  // オフロード判定はplayerと同じ規則: 足元(下端, +16)の行をサンプルする。
  const centerPx = toPx(e.x) + 8;
  e.offRoad = isOffRoadAt(curScrollY, centerPx, toPx(e.y) + 16);

  // e.vy自体は生成時定数のまま書き換えない（onroad復帰時に巻き戻す必要をなくすため）。
  // 決定事項: SNAKEの横方向の蛇行(timerベース)は複雑化を避けて非スケール対象のままとし、
  // 「移動速度2/3」・「自機死亡演出中のスクロール速度比」は支配的な縦方向の進行(vy)にのみ適用する。
  let scaledVy = fmul(e.vy, curEnemySpeedRatio); // 自機死亡演出中〜復活の間、世界全体を一緒にスローにする
  if (e.atkTimer <= TELEGRAPH_SLOWDOWN_FRAMES) {
    scaledVy = fmul(scaledVy, TELEGRAPH_SLOWDOWN_NUM);
  }
  const vy = e.offRoad ? fmul(scaledVy, ENEMY_SPEED_OFFROAD_NUM) : scaledVy;
  e.y += vy;

  if (toPx(e.y) > 160) {
    e.alive = false;
    return;
  }

  // 死亡演出中(curSpawnFrozen)は発射予備動作ごと完全に停止する（構え点滅も進まない）。
  // 発射予備動作つきの攻撃サイクル。先に減速し、TELEGRAPH_FRAMES以下になると描画側がpalInvertを点滅させる。
  // atkTimerがTELEGRAPH_FRAMES以下に達するまでは絶対に発射しないので、予備動作なしで撃つ敵は存在しない。
  if (curSpawnFrozen) {
    return;
  }
  e.atkTimer -= 1;
  if (e.atkTimer <= 0) {
    if (isPlayerTooCloseToFire(e)) {
      // 至近距離の回避不能弾を作らないため、攻撃をキャンセルせずready状態で保持する。
      // 自機が32x32中心距離の外へ出たフレームで発射し、範囲内では絶対にspawnしない。
      e.atkTimer = 1;
      return;
    }
    fireEnemyBullet(e);
    e.atkTimer = FIRE_INTERVAL_BASE + rndRange(FIRE_INTERVAL_JITTER);
  }
}

function isPlayerTooCloseToFire(e) {
  let dx = curPlayerX + SPRITE_CENTER_OFFSET - (e.x + SPRITE_CENTER_OFFSET);
  let dy = curPlayerY + SPRITE_CENTER_OFFSET - (e.y + SPRITE_CENTER_OFFSET);
  if (dx < 0) {
    dx = -dx;
  }
  if (dy < 0) {
    dy = -dy;
  }
  return dx <= ENEMY_FIRE_PROXIMITY && dy <= ENEMY_FIRE_PROXIMITY;
}

function fireEnemyBullet(e) {
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return;
  }

  // 決定事項: COLUMN編隊は固定方向(真下)、V/SNAKEは自機狙い。両パターンを実装する要件を満たす。
  const dirIdx = e.kind === KIND_COLUMN ? ENEMY_BULLET_FIXED_DIR : aim16(curPlayerX - e.x, curPlayerY - e.y);
  const dir = DIR16[dirIdx];

  b.dirIdx = dirIdx;
  b.x = e.x + f(4);
  b.y = e.y + f(12);
  b.vx = fmul(dir.dx, f(ENEMY_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(ENEMY_BULLET_SPEED));
  b.tile = ENEMY_BULLET_TILE;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = 0;
}

// sectionIndex>=2 は STAGES[0].sections の boss セクション(index2)に到達済みという意味。
// game.js はこれを見てボス戦への遷移トリガに使う。
export function isAtBossSection() {
  return sectionIndex >= 2;
}

// デバッグ観測用(window.__bagulas)。読み取り専用の公開で、ロジックからの逆参照はない。
export function getSectionIndex() {
  return sectionIndex;
}

// ボス戦突入時などにゾコ敵を一括撃破せず即消去する（スプライト/スキャンライン枠をボス用に空ける）。
export function clearEnemies() {
  forEach(ENEMIES, killSlot);
}

// speedRatio: 8.8固定小数点(256=等倍)。自機死亡演出〜復活の間、game.jsの現在スクロール速度から
// 算出して渡される（通常時は常に256=等速）。spawnFrozen: 死亡演出中はtrueになり、スポーン/発射を止める。
export function updateEnemies(distance, playerX, playerY, scrollY, speedRatio, spawnFrozen) {
  curPlayerX = playerX;
  curPlayerY = playerY;
  curScrollY = scrollY;
  curDistance = distance;
  curEnemySpeedRatio = speedRatio;
  curSpawnFrozen = spawnFrozen;
  if (!spawnFrozen) {
    advanceSection(distance);
    spawnPendingWave(distance);
  }
  forEach(ENEMIES, updateOneEnemy);
}

function isBulletOffscreen(b) {
  const px = toPx(b.x);
  const py = toPx(b.y);
  return px < -16 || px > 160 || py < -16 || py > 144;
}

function updateOneEnemyBullet(b) {
  b.x += b.vx;
  b.y += b.vy;
  if (isBulletOffscreen(b)) {
    b.alive = false;
  }
}

export function updateEnemyBullets() {
  forEach(ENEMY_BULLETS, updateOneEnemyBullet);
}

// 決定事項: stages.jsのod.xはあくまで「希望x」。新構造では画面全面が基本オンロードで、
// オフロードは左右からせいぜいMAX_OFFROAD_EACH列しか張り出さないため、gfx.jsが公開する
// SAFE_ONROAD_LEFT_PX..SAFE_ONROAD_RIGHT_PXの帯は常にオンロードであることが構造的に保証される。
// 障害物幅16pxがその帯からはみ出さないようclampするだけでよく、行ごとのscrollY参照は不要になった。
function computeObstacleX(preferredX) {
  let x = preferredX;
  if (x < SAFE_ONROAD_LEFT_PX) {
    x = SAFE_ONROAD_LEFT_PX;
  }
  const maxX = SAFE_ONROAD_RIGHT_PX - 16; // 障害物幅16pxが帯の右端にかからない上限
  if (x > maxX) {
    x = maxX;
  }
  return x;
}

function initObstacle(o, od) {
  o.x = f(computeObstacleX(od.x));
  o.y = f(-16);
  o.vx = 0;
  o.vy = 0; // 実際の下降量は毎フレームcurObstacleVy(=現在のスクロール速度)を使う。詳細はupdateOneObstacle参照
  o.timer = 0;
  o.kind = 0;

  if (od.kind === OBSTACLE_KINDS.ROCK.id) {
    o.tile = TILE16_ROCK;
    o.hp = OBSTACLE_HP;
    o.flags = 1; // destructible
  } else if (od.kind === OBSTACLE_KINDS.CACTUS.id) {
    o.tile = TILE16_CACTUS;
    o.hp = OBSTACLE_HP;
    o.flags = 1; // destructible
  } else {
    // FENCE
    o.tile = TILE16_FENCE;
    o.hp = 0;
    o.flags = 0; // 破壊不可
  }
}

// stage1Mainのobstaclesのみを対象にする。prelude/bossのobstacles配列は空なので自然に何も起きないが、
// セクションindexでも明示的にmainのみへ限定しておく（前提を崩さないため）。
function spawnPendingObstacles(distance) {
  if (sectionIndex !== 1) {
    return;
  }
  const section = STAGES[0].sections[1];
  const obstacles = section.obstacles;
  const localDistance = distance - sectionStartDistance;

  while (obstacleCursor < obstacles.length && obstacles[obstacleCursor].at <= localDistance) {
    const od = obstacles[obstacleCursor];
    const o = spawn(OBSTACLES);
    if (!o) {
      return; // プール満杯。cursorを進めず次フレームに再試行
    }
    initObstacle(o, od);
    obstacleCursor += 1;
  }
}

function updateOneObstacle(o) {
  o.y += curObstacleVy; // 現在のスクロール速度そのもの。止まれば障害物も止まる
  if (toPx(o.y) > 160) {
    o.alive = false;
  }
}

// scrollSpeed: game.js側の現在のスクロール速度(8.8固定小数点)。障害物はこれに完全追従する。
export function updateObstacles(distance, scrollSpeed) {
  advanceSection(distance);
  spawnPendingObstacles(distance);
  curObstacleVy = scrollSpeed;
  forEach(OBSTACLES, updateOneObstacle);
}

function drawOneEnemy(e) {
  let palInvert = false;
  if (e.flashTimer > 0) {
    palInvert = true;
  } else if (e.atkTimer <= TELEGRAPH_FRAMES) {
    // 発射TELEGRAPH_FRAMES前から4フレーム周期でpalInvertを切り替えて構えモーションを表現する
    palInvert = ((e.atkTimer >> TELEGRAPH_BLINK_SHIFT) & 1) === 0;
  }
  // オフロード時の上下1pxガタガタ揺れ（描画のみ。e.y自体は変更しないので当たり判定に影響しない）。
  // 周期をSHAKE_PERIOD_SHIFT分伸ばして控えめにする(game.jsのplayer側と同じ考え方)。
  const shakeY = e.offRoad ? (((curDistance >> SHAKE_PERIOD_SHIFT) & 1) ? -1 : 1) : 0;
  pushMeta16(toPx(e.x), toPx(e.y) + shakeY, e.tile, 0, palInvert);
}

export function drawEnemies() {
  forEach(ENEMIES, drawOneEnemy);
}

function drawOneEnemyBullet(b) {
  pushSprite(toPx(b.x), toPx(b.y), b.tile, 0);
}

export function drawEnemyBullets() {
  forEach(ENEMY_BULLETS, drawOneEnemyBullet);
}

function drawOneObstacle(o) {
  drawBGObject(toPx(o.x), toPx(o.y), o.tile);
}

export function drawObstacles() {
  forEach(OBSTACLES, drawOneObstacle);
}

function spawnEnemyExplosion(x, y) {
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = x;
  eff.y = y;
  eff.vx = 0;
  eff.vy = 0;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_ENEMY_EXPLOSION;
  eff.tile = ENEMY_EXPLOSION_TILES[0];
  eff.radius = 0;
}

function spawnOneDebris(x, y, vx, vy) {
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = x;
  eff.y = y;
  eff.vx = vx;
  eff.vy = vy;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_DEBRIS;
  eff.tile = 1;
  eff.radius = 0;
}

function spawnScorePop(x, y, value) {
  const p = spawn(SCORE_POPS);
  if (!p) {
    return;
  }
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = -64; // ゆっくり上に浮く(8.8固定小数点)
  p.hp = 0;
  p.flags = 0;
  p.timer = 0;
  p.kind = 0;
  p.tile = 0;
  p.value = value;
}

// damageEnemy(e, dmg): ダメージを与え、撃破時は爆発/破片/スコアポップを発生させ、
// game.js側で score に加算すべき値を返す（撃破しなければ0を返す）。
export function damageEnemy(e, dmg) {
  e.hp -= dmg;
  e.flashTimer = HIT_FLASH_FRAMES;
  if (e.hp <= 0) {
    e.alive = false;
    spawnEnemyExplosion(e.x, e.y);
    spawnOneDebris(e.x, e.y, -f(1), -f(1));
    spawnOneDebris(e.x, e.y, f(1), -f(1));
    spawnScorePop(e.x, e.y, ENEMY_SCORE_VALUE);
    return ENEMY_SCORE_VALUE;
  }
  return 0;
}

// damageObstacle(o, dmg): 破壊不可(FENCE)は何もせず0を返す。破壊可はhpを減らし、
// 破壊時は爆発+スコアポップを発生させ加算すべきスコアを返す。
export function damageObstacle(o, dmg) {
  if ((o.flags & 1) === 0) {
    return 0;
  }
  o.hp -= dmg;
  if (o.hp <= 0) {
    o.alive = false;
    spawnEnemyExplosion(o.x, o.y);
    spawnScorePop(o.x, o.y, OBSTACLE_SCORE_VALUE);
    return OBSTACLE_SCORE_VALUE;
  }
  return 0;
}
