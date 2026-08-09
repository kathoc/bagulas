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
    lastDrawnFrame: -1, // 検証用: pushSprite/pushMeta16が真を返した時点のフレーム番号。spawn時に-1へ初期化する。
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

// ENEMIES: 敵プール（最大20）。src/enemies.js（段階3: 敵5種実装）が生成・更新する。
// 段階3でプールサイズを12→20へ拡張した(採用理由はsrc/enemies.jsの実測コメント参照)。
// ガンワゴン(720フレーム居座り+入退場)やホイールソー(低速降下)のように長時間生存する編隊が
// 増えたため、12のままだと後続ウェーブがspawn()失敗で長時間ブロックされ、5種すべてが
// 実プレイ時間内に出現しない事態が実測で確認された。40スプライト上限は変えない
// (ちらつき機構forEachFromが既にあるため、プールを増やしても表示上限は超えない)。
export const ENEMIES = makePool(20, (s) => {
  s.atkTimer = 0;
  s.formationId = 0;
  s.anchorX = 0; // SNAKE編隊の振動中心x（8.8固定小数点）。vxの流用をやめて専用化。
  s.anchorY = 0; // 振り付けの停止位置y（8.8固定小数点）。個体ごとにずらす。
  s.localFrame = 0; // 振り付け用の「自分の時計」。負の間はまだ出発していない（1体ごとの時間差）。
  s.travelFrames = 0; // 振り付けの進入で「何フレーム進んで止まるか」。停止位置は座標ではなくこれで持つ。
  s.flashTimer = 0; // 被弾白フラッシュの残フレーム数。flags上位ビットの流用をやめて専用化。
  s.offRoad = false;
  s.everOnscreen = false; // 一度でも画面内に入ったことがあるか。spawn待機位置での誤消滅を防ぐため必須。
  s.fireCount = 0; // これまでに発射した回数(一撃離脱の判定に使う)。
  s.fireLimit = 0; // この個体が離脱するまでに撃てる回数。kind別にspawn時決定(0=このフィールド未使用)。
  s.leaveTimer = 0; // spawn以降の経過フレーム数(発射回数と独立の時間ベース離脱に使う汎用カウンタ)。
  s.leaving = false; // 既に(発射回数/時間どちらかの経路で)離脱がトリガー済みか。二重トリガー防止。
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
      slot.lastDrawnFrame = -1; // 使い回しスロットなので、前回生存時の描画履歴を必ず捨てる
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

// forEachFrom(pool, startFrame, fn): forEachと同じだが、走査の開始indexを
// startFrame(通常はフレームカウンタをそのまま渡す)から pool.length で割った余りにする。
// 呼ぶたびに開始位置がずれるため、スプライト枠が足りず末尾が毎回捨てられる状況でも
// 「同じ個体だけが永久に描かれない」状態を避けられる（実機GBのちらつきに相当）。
// 配列やクロージャは一切生成しない（インデックス計算のみ）。
export function forEachFrom(pool, startFrame, fn) {
  const n = pool.length;
  let start = startFrame % n;
  if (start < 0) {
    start += n;
  }
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const slot = pool[idx];
    if (slot.alive) {
      fn(slot, idx);
    }
  }
}
