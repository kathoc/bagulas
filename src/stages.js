// stages.js — ステージ・ウェーブ・障害物のテーブル駆動データ
// 移植性ルール準拠: float リテラル禁止 / Math.random 禁止。整数演算のみ。
// データ構造は docs/plans/m1-plan.md の stages.js 節に準拠。

// 編隊フォーメーション種別（Step 3 実装側が参照する固定名）
export const FORMATIONS = Object.freeze({
  V: 'V',
  COLUMN: 'COLUMN',
  SNAKE: 'SNAKE',
});

// 障害物種別と破壊可否テーブル
// ROCK / CACTUS は自弾で破壊可能。FENCE は破壊不可（避けるしかない）。
export const OBSTACLE_KINDS = Object.freeze({
  ROCK: { id: 'ROCK', destructible: true },
  FENCE: { id: 'FENCE', destructible: false },
  CACTUS: { id: 'CACTUS', destructible: true },
});

// 出現口(5か所)。前3(画面上端から降下) / 後2(画面下端から追い上げ)。
// BACK_AUTO は「背後タイプは自機が居ない側から出す」ためのプレースホルダで、
// enemies.js が wave 開始時の自機x座標を見て BACK_LEFT/BACK_RIGHT のどちらかへ解決する。
export const GATES = Object.freeze({
  FRONT_LEFT: 0,
  FRONT_RIGHT: 1,
  FRONT_CENTER: 2,
  BACK_LEFT: 3,
  BACK_RIGHT: 4,
  BACK_AUTO: 5,
});

// 敵種別ごとに使える出現口(データとして保持)。「正面のみ」等の性質をここで表現する。
// 段階3(敵16種実装)で種ごとの正式なセットに拡張していく。現段階は既存3種(V/COLUMN/SNAKE)へ
// 暫定のセットを与え、5出現口すべてが使われるようにしている。
export const FORMATION_GATES = Object.freeze({
  [FORMATIONS.V]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT, GATES.FRONT_CENTER],
  [FORMATIONS.COLUMN]: [GATES.FRONT_CENTER],
  [FORMATIONS.SNAKE]: [GATES.BACK_AUTO],
});

// 周回ごとの整数倍率適用ヘルパ。
// baseValue に loop*step を加算するだけの整数演算（float 禁止）。
// 例: applyLoop(hp, loop)        -> hp + loop
//     applyLoop(speed, loop, 16) -> speed + loop*16
export function applyLoop(baseValue, loop, step) {
  const s = step === undefined ? 1 : step;
  return (baseValue + loop * s) | 0;
}

// ステージ1: 荒野 -----------------------------------------------------
// prelude: 障害物なし、編隊戦のみ（グラディウス空中戦風）
// main: 岩/柵/サボテンの障害物 + 編隊
// boss: ライバルレーサー1体目

const STAGE1_PRELUDE_LENGTH = 800;
const STAGE1_MAIN_LENGTH = 1400;

// waves: 1ウェーブ=1種類・3〜5機・出現口1か所。ウェーブ間の空き(90〜150フレーム)は
// enemies.js が実行時にLFSRで決めるため、ここでは距離(at)を持たず「順序」だけを表現する。
// 同じ種類を出現口を変えて数ウェーブ続け、そのあと種類を切り替える並びにしてある。
const stage1Prelude = {
  type: 'prelude',
  length: STAGE1_PRELUDE_LENGTH,
  waves: [
    { formation: FORMATIONS.V, count: 3, hp: 2, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.V, count: 4, hp: 2, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.V, count: 3, hp: 2, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.COLUMN, count: 4, hp: 2, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.SNAKE, count: 5, hp: 1, gate: GATES.BACK_AUTO },
  ],
  obstacles: [],
};

const stage1Main = {
  type: 'main',
  length: STAGE1_MAIN_LENGTH,
  waves: [
    { formation: FORMATIONS.V, count: 3, hp: 3, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.V, count: 4, hp: 3, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.V, count: 3, hp: 4, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.COLUMN, count: 4, hp: 3, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.COLUMN, count: 5, hp: 4, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.SNAKE, count: 4, hp: 2, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.SNAKE, count: 5, hp: 3, gate: GATES.BACK_AUTO },
  ],
  obstacles: [
    { at: 150, kind: OBSTACLE_KINDS.ROCK.id, x: 32 },
    { at: 210, kind: OBSTACLE_KINDS.CACTUS.id, x: 96 },
    { at: 340, kind: OBSTACLE_KINDS.FENCE.id, x: 64 },
    { at: 420, kind: OBSTACLE_KINDS.ROCK.id, x: 112 },
    { at: 480, kind: OBSTACLE_KINDS.CACTUS.id, x: 24 },
    { at: 620, kind: OBSTACLE_KINDS.FENCE.id, x: 88 },
    { at: 700, kind: OBSTACLE_KINDS.ROCK.id, x: 40 },
    { at: 780, kind: OBSTACLE_KINDS.CACTUS.id, x: 120 },
    { at: 900, kind: OBSTACLE_KINDS.FENCE.id, x: 56 },
    { at: 980, kind: OBSTACLE_KINDS.ROCK.id, x: 100 },
    { at: 1120, kind: OBSTACLE_KINDS.CACTUS.id, x: 72 },
    { at: 1250, kind: OBSTACLE_KINDS.FENCE.id, x: 32 },
  ],
};

const stage1Boss = {
  type: 'boss',
  length: 0,
  waves: [],
  obstacles: [],
  bossId: 1,
};

// ステージ2〜6: M1 では骨組みのみ ---------------------------------------
// 空セクションは length:0 / waves:[] / obstacles:[] で統一する。

function emptySection(type, bossId) {
  const section = { type, length: 0, waves: [], obstacles: [] };
  if (type === 'boss') section.bossId = bossId;
  return section;
}

// ステージ5: 海の上 — ボスラッシュ
// ステージ1〜4のボス（強化再戦）→ 新ボス5体目
const stage5BossRush = [
  { type: 'boss', length: 0, waves: [], obstacles: [], bossId: 1, powered: true },
  { type: 'boss', length: 0, waves: [], obstacles: [], bossId: 2, powered: true },
  { type: 'boss', length: 0, waves: [], obstacles: [], bossId: 3, powered: true },
  { type: 'boss', length: 0, waves: [], obstacles: [], bossId: 4, powered: true },
  { type: 'boss', length: 0, waves: [], obstacles: [], bossId: 5, powered: false },
];

export const STAGES = [
  {
    id: 1,
    name: 'WILDERNESS',
    tileset: 'wilderness',
    sections: [stage1Prelude, stage1Main, stage1Boss],
  },
  {
    id: 2,
    name: 'JUNGLE',
    tileset: 'jungle',
    sections: [],
  },
  {
    id: 3,
    name: 'OASIS',
    tileset: 'oasis',
    sections: [],
  },
  {
    id: 4,
    name: 'VOLCANO',
    tileset: 'volcano',
    sections: [],
  },
  {
    id: 5,
    name: 'HIGH SEAS',
    tileset: 'sea',
    // ボスラッシュ: 1〜4の強化再戦 + 新ボス5
    sections: stage5BossRush,
  },
  {
    id: 6,
    name: 'CAVERN',
    tileset: 'cavern',
    // 最終ボス: 脳がむき出しのメカ(bossId:6) = レース主催者の正体
    sections: [emptySection('boss', 6)],
  },
];
