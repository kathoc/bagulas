// stages.js — ステージ・ウェーブ・障害物のテーブル駆動データ
// 移植性ルール準拠: float リテラル禁止 / Math.random 禁止。整数演算のみ。
// データ構造は docs/plans/m1-plan.md の stages.js 節に準拠。

// 編隊フォーメーション種別（段階3: 敵5種実装。値はそのままenemies.jsのkindディスパッチへ渡る）
export const FORMATIONS = Object.freeze({
  SCATTER: 'SCATTER',
  DRIFTER: 'DRIFTER',
  REAPER: 'REAPER',
  GUNWAGON: 'GUNWAGON',
  WHEELSAW: 'WHEELSAW',
  // 段階3グループ2(docs/enemies.md #4,#6,#7,#14)
  HOPPER: 'HOPPER',
  SANDWORM: 'SANDWORM',
  SIDECAR: 'SIDECAR',
  MOTHER: 'MOTHER',
  // 段階3グループ3(docs/enemies.md #8,#9)
  MIRAGE: 'MIRAGE',
  CHASER: 'CHASER',
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
  // サンドワーム専用: 「出現口の概念を持たない」(docs/enemies.md #6)ためのプレースホルダ。
  // waveの並び/空き時間の仕組みはそのまま使いたいので値としては用意するが、
  // enemies.jsのinitSandwormはこの値からx/yを一切導出しない(自機位置基準で独自に決める)。
  UNDERGROUND: 6,
});

// 敵種別ごとに使える出現口(データとして保持)。「正面のみ」等の性質をここで表現する。
// docs/enemies.md の出現口列に対応（スキャッター/ドリフター=前3か所、リーパー/ホイールソー=前左右のみ、
// ガンワゴン=正面のみ）。waves側でここに無い出現口を指定しないよう手で守る（実行時チェックはしない）。
export const FORMATION_GATES = Object.freeze({
  [FORMATIONS.SCATTER]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT, GATES.FRONT_CENTER],
  [FORMATIONS.DRIFTER]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT, GATES.FRONT_CENTER],
  [FORMATIONS.REAPER]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT],
  [FORMATIONS.GUNWAGON]: [GATES.FRONT_CENTER],
  [FORMATIONS.WHEELSAW]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT],
  // 段階3グループ2(docs/enemies.md 一覧表の出現口列に対応)
  [FORMATIONS.HOPPER]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT, GATES.FRONT_CENTER],
  [FORMATIONS.SANDWORM]: [GATES.UNDERGROUND],
  [FORMATIONS.SIDECAR]: [GATES.FRONT_LEFT, GATES.FRONT_RIGHT],
  [FORMATIONS.MOTHER]: [GATES.FRONT_CENTER],
  // 段階3グループ3(背後出現は自動解決に一本化する)
  [FORMATIONS.MIRAGE]: [GATES.BACK_AUTO],
  [FORMATIONS.CHASER]: [GATES.BACK_AUTO],
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
// 同じ種類を出現口を変えて数ウェーブ続けてから種類を切り替える並び（docs/enemies.md「ウェーブの並べ方」）。
// 前哨戦は「弾を持たない敵を中心に」の方針どおりスキャッター/リーパー/ホイールソー(無称号)を主体にしつつ、
// ドリフターも1〜2ウェーブだけ混ぜて「折り返しで撃つ」を早期に見せる。ガンワゴンは弾を持つため本編へ回す。
const stage1Prelude = {
  type: 'prelude',
  length: STAGE1_PRELUDE_LENGTH,
  waves: [
    { formation: FORMATIONS.SCATTER, count: 3, hp: 2, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.SCATTER, count: 4, hp: 2, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.SCATTER, count: 3, hp: 2, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.DRIFTER, count: 4, hp: 2, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.DRIFTER, count: 4, hp: 2, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.REAPER, count: 5, hp: 1, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.REAPER, count: 5, hp: 1, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.WHEELSAW, count: 3, hp: 1, gate: GATES.FRONT_LEFT },
  ],
  obstacles: [],
};

// 本編: 荒野の主力はスキャッター/ドリフター、混ぜる敵としてガンワゴン/ホイールソー(docs/enemies.md
// 「ステージ別の配分」)。リーパーも1ウェーブ再登場させ、5種すべてがstage1内で出現する構成にする。
const stage1Main = {
  type: 'main',
  length: STAGE1_MAIN_LENGTH,
  waves: [
    { formation: FORMATIONS.SCATTER, count: 3, hp: 3, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.SCATTER, count: 4, hp: 3, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.SCATTER, count: 3, hp: 4, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.DRIFTER, count: 4, hp: 3, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.DRIFTER, count: 5, hp: 4, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.DRIFTER, count: 4, hp: 3, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.GUNWAGON, count: 3, hp: 4, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.WHEELSAW, count: 3, hp: 1, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.REAPER, count: 5, hp: 1, gate: GATES.FRONT_RIGHT },
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

// ステージ2: ジャングル ------------------------------------------------
// 段階3グループ2(ホッパー/サンドワーム/サイドカー/マザー)の検証用に定義する。
// docs/enemies.md「ステージ別の配分」: 主力ホッパー/マザー、混ぜるサンドワーム/サイドカー。
// 障害物(倒木・巨大植物・沼)は本タスクの対象外のため obstacles は空のままにする。
// game.js の isStagePlayable() は現状 stageIndex===0 のみを実プレイ対象にしているため、
// このセクションは通常のステージ進行では到達しない(M1のスコープ外)。
// 検証は enemies.js の startAtWave(sectionIdx, waveIdx, stageIdx) 経由(game.startPlayAtの第4引数)で行う。
const STAGE2_PRELUDE_LENGTH = 800;
const STAGE2_MAIN_LENGTH = 1400;

const stage2Prelude = {
  type: 'prelude',
  length: STAGE2_PRELUDE_LENGTH,
  waves: [
    { formation: FORMATIONS.HOPPER, count: 3, hp: 3, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.HOPPER, count: 3, hp: 3, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.HOPPER, count: 3, hp: 3, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.SIDECAR, count: 4, hp: 2, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.SIDECAR, count: 4, hp: 2, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.SANDWORM, count: 3, hp: 3, gate: GATES.UNDERGROUND },
  ],
  obstacles: [],
};

const stage2Main = {
  type: 'main',
  length: STAGE2_MAIN_LENGTH,
  waves: [
    { formation: FORMATIONS.HOPPER, count: 3, hp: 4, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.SANDWORM, count: 3, hp: 4, gate: GATES.UNDERGROUND },
    { formation: FORMATIONS.SIDECAR, count: 4, hp: 3, gate: GATES.FRONT_RIGHT },
    { formation: FORMATIONS.HOPPER, count: 3, hp: 4, gate: GATES.FRONT_CENTER },
    // マザー出現中は射出したスキャッターがENEMIESプール(20)を食うため、編隊数を3のまま
    // 単独ウェーブとして挟み、前後のウェーブと重ならせない(gateはFRONT_CENTER固定=正面のみ)。
    { formation: FORMATIONS.MOTHER, count: 3, hp: 5, gate: GATES.FRONT_CENTER },
    { formation: FORMATIONS.SIDECAR, count: 4, hp: 3, gate: GATES.FRONT_LEFT },
    { formation: FORMATIONS.SANDWORM, count: 3, hp: 4, gate: GATES.UNDERGROUND },
    { formation: FORMATIONS.MOTHER, count: 3, hp: 5, gate: GATES.FRONT_CENTER },
  ],
  obstacles: [],
};

const stage2Boss = {
  type: 'boss',
  length: 0,
  waves: [],
  obstacles: [],
  bossId: 2,
};

// ステージ3: オアシス ---------------------------------------------------
// 段階3グループ3(ミラージュ/チェイサー)の検証用に定義する。docs/enemies.md「ステージ別の配分」は
// 「主力ミラージュ、チェイサー / 混ぜるガンワゴン、リーパー」だが、段階3グループ2の前例(ステージ2は
// 自グループの4種のみで構成し、既存グループを混ぜていない)に合わせ、本ステージもグループ3の2種のみで
// 構成する(スコープ外の種を混ぜない)。
// game.js の isStagePlayable() は現状 stageIndex===0 のみを実プレイ対象にしているため、
// このセクションは通常のステージ進行では到達しない。検証は game.startPlayAt(section, wave, invuln, 2) 経由で行う。
const STAGE3_PRELUDE_LENGTH = 800;
const STAGE3_MAIN_LENGTH = 1400;

const stage3Prelude = {
  type: 'prelude',
  length: STAGE3_PRELUDE_LENGTH,
  waves: [
    { formation: FORMATIONS.MIRAGE, count: 3, hp: 4, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.CHASER, count: 3, hp: 4, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.MIRAGE, count: 3, hp: 4, gate: GATES.BACK_AUTO },
  ],
  obstacles: [],
};

const stage3Main = {
  type: 'main',
  length: STAGE3_MAIN_LENGTH,
  waves: [
    { formation: FORMATIONS.CHASER, count: 3, hp: 5, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.MIRAGE, count: 3, hp: 5, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.CHASER, count: 3, hp: 5, gate: GATES.BACK_AUTO },
    { formation: FORMATIONS.MIRAGE, count: 3, hp: 5, gate: GATES.BACK_AUTO },
  ],
  obstacles: [],
};

const stage3Boss = {
  type: 'boss',
  length: 0,
  waves: [],
  obstacles: [],
  bossId: 3,
};

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
    sections: [stage2Prelude, stage2Main, stage2Boss],
  },
  {
    id: 3,
    name: 'OASIS',
    tileset: 'oasis',
    sections: [stage3Prelude, stage3Main, stage3Boss],
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
