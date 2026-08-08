// entities.js — 固定長オブジェクトプール（起動時に1回だけ確保、毎フレームの生成は禁止）
// 各スロットは alive フラグで管理する。座標・速度は fixed.js の 8.8 固定小数点整数。
// 型別の追加フィールドもスロット生成時に全て事前確保し、後から動的追加はしない。

// 全プール共通のベースフィールドを1スロット分作る（プール生成時のみ呼ぶ。update中には呼ばない）
function makeBaseSlot() {
  return {
    alive: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    tile: 0,
    hp: 0,
    flags: 0,
    timer: 0,
    kind: 0,
  };
}

function makePool(size, extendFn) {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    const slot = makeBaseSlot();
    if (extendFn) {
      extendFn(slot);
    }
    arr[i] = slot;
  }
  return arr;
}

// PLAYER_BULLETS: 自弾プール（最大2）。weapons.js の fire()/updateBullets() が管理。
// 追加フィールド: kind=武器ID, lastHitEnemy=鉄球の貫通クールダウン対象(敵プールindex,-1で無し),
// hitCooldown=同一敵への再ヒット禁止タイマー(フレーム)。flags bit0=pierce(貫通)。
export const PLAYER_BULLETS = makePool(2, (s) => {
  s.lastHitEnemy = -1;
  s.hitCooldown = 0;
});

// ENEMIES: 敵プール（最大12）。src/enemies.js（Step3）が生成・更新する。
// 追加フィールド: atkTimer=発射予備動作までの残フレーム, formationId=編隊識別用,
// anchorX=SNAKE編隊の振動中心x（8.8固定小数点）, flashTimer=被弾白フラッシュの残フレーム数,
// offRoad=直近フレームでオフロード判定だったか（速度2/3・描画シェイクに使用。毎フレーム再計算）。
export const ENEMIES = makePool(12, (s) => {
  s.atkTimer = 0;
  s.formationId = 0;
  s.anchorX = 0; // SNAKE編隊の振動中心x（8.8固定小数点）。vxの流用をやめて専用化。
  s.flashTimer = 0; // 被弾白フラッシュの残フレーム数。flags上位ビットの流用をやめて専用化。
  s.offRoad = false;
});

// ENEMY_BULLETS: 敵弾プール（最大8）。src/enemies.js（Step3）が生成・更新する。
// 追加フィールド: dirIdx=DIR16のインデックス（狙い弾/固定方向弾の向き）。
export const ENEMY_BULLETS = makePool(8, (s) => {
  s.dirIdx = 0;
});

// EFFECTS: 演出用プール（最大8, 爆発/破片/被弾フラッシュ等）。weapons.js/enemies.js/game.js が使う。
// 追加フィールド: radius=当たり判定用の爆風半径(8.8, ダイナマイト等の小範囲爆発フラグに使用)。
export const EFFECTS = makePool(8, (s) => {
  s.radius = 0;
});

// OBSTACLES: 障害物プール（最大12, 岩/柵/サボテン）。src/stages.js/game.js（Step3/4）が生成・更新する。
// 追加フィールド: なし（destructible=破壊可否は flags bit0 で表現、hp は破壊可障害物のみ使用）。
export const OBSTACLES = makePool(12, () => {});

// SCORE_POPS: スコア加算演出プール（最大4）。game.js が撃破/破壊時に生成する。
// 追加フィールド: value=表示・加算するスコア量。
export const SCORE_POPS = makePool(4, (s) => {
  s.value = 0;
});

// SMOKE: オフロード演出用の砂煙パーティクルプール（最大8）。game.js が自機オフロード時に生成・更新・描画する。
// 追加フィールド: なし（x/y/vy/timerは基底スロットのものをそのまま使う。tileはTILE_SMOKE固定）。
export const SMOKE = makePool(8, () => {});

// spawn(pool): 空きスロットを探して alive=true にして返す。空きが無ければ null。
// プール内を先頭から線形探索するだけで、新規オブジェクト/配列は生成しない。
export function spawn(pool) {
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    if (!slot.alive) {
      slot.alive = true;
      return slot;
    }
  }
  return null;
}

// forEach(pool, fn): 生存中のスロットのみ fn(slot, index) を呼ぶ通常のforループ。
// 配列コピーやクロージャ生成は行わない。fn 自体は呼び出し側で使い回す関数参照を渡すこと。
export function forEach(pool, fn) {
  for (let i = 0; i < pool.length; i++) {
    const slot = pool[i];
    if (slot.alive) {
      fn(slot, i);
    }
  }
}
