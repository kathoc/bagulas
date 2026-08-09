// tiles.js — 8x8 2bppタイルデータ生成
// 各タイルは Uint8Array(64)。値は 0..3 のパレットインデックス（0=最明 ... 3=最暗）。
// 16x16メタスプライト用タイルのうち実素材由来のもの（自機/敵/障害物/ボス/爆発）は
// art/generated/*.js（tools/spritelab_gen.py --convert-art のオフライン一発生成物）を
// そのまま輸入する。値は0..4（4=透明）。ここでは画像デコードは一切行わず、
// 生成済みの静的JS配列をインポートするだけ。

import { TILE_PLAYER_BUGGY } from '../art/generated/player_buggy.js';
import { TILE_ENEMY_BIKE } from '../art/generated/enemy_bike.js';
import { TILE_ENEMY_CAR } from '../art/generated/enemy_car.js';
import { TILE_BOSS_RIVAL } from '../art/generated/boss_rival.js';
import { TILE_OBSTACLE_ROCK } from '../art/generated/obstacle_rock.js';
import { TILE_OBSTACLE_FENCE } from '../art/generated/obstacle_fence.js';
import { TILE_OBSTACLE_CACTUS } from '../art/generated/obstacle_cactus.js';
import {
  TILE_EXPLOSION_FRAME0,
  TILE_EXPLOSION_FRAME1,
  TILE_EXPLOSION_FRAME2,
} from '../art/generated/explosion.js';
import { TILE_ENEMY_SCATTER } from '../art/generated/enemy_scatter.js';
import { TILE_ENEMY_DRIFTER } from '../art/generated/enemy_drifter.js';
import { TILE_ENEMY_REAPER } from '../art/generated/enemy_reaper.js';
import { TILE_ENEMY_GUNWAGON } from '../art/generated/enemy_gunwagon.js';
import { TILE_ENEMY_WHEELSAW } from '../art/generated/enemy_wheelsaw.js';
import { TILE_ENEMY_HOPPER } from '../art/generated/enemy_hopper.js';
import { TILE_ENEMY_SANDWORM } from '../art/generated/enemy_sandworm.js';
import { TILE_ENEMY_SIDECAR } from '../art/generated/enemy_sidecar.js';
import { TILE_ENEMY_MOTHER } from '../art/generated/enemy_mother.js';
import { TILE_ENEMY_MIRAGE } from '../art/generated/enemy_mirage.js';
import { TILE_ENEMY_CHASER } from '../art/generated/enemy_chaser.js';

function emptyTile(fill) {
  const t = new Uint8Array(64);
  if (fill) {
    t.fill(fill);
  }
  return t;
}

function setPx(tile, x, y, v) {
  if (x < 0 || x > 7 || y < 0 || y > 7) {
    return;
  }
  tile[y * 8 + x] = v;
}

// タイル(8x8)の index3 シルエットへ、index0 の1px アウトラインを付ける。
// 透明(4)かつ index3 ピクセルに4方向で隣接するセルだけを index0 にする（シルエット自体は変えない）。
// 弾が暗い路面/障害物どちらの上でも輪郭が分離して見えるようにするための処理。ビルド時(起動時)1回だけ呼ぶ。
function addOutline3(tile) {
  const src = tile.slice(); // 元の3の位置を判定に使う（書き込み中に自分自身を参照して汚染しないため）
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const p = y * 8 + x;
      if (src[p] !== 4) continue;
      let touches = false;
      if (x > 0 && src[p - 1] === 3) touches = true;
      if (x < 7 && src[p + 1] === 3) touches = true;
      if (y > 0 && src[p - 8] === 3) touches = true;
      if (y < 7 && src[p + 8] === 3) touches = true;
      if (touches) tile[p] = 0;
    }
  }
  return tile;
}

// 0: 荒野（道の外）— 路面より1段暗いトーン。道と即座に区別できる基準色。
function tileEmpty() {
  return emptyTile(1);
}

// 1: 道の路面（4階調中もっとも明るいトーン。荒野より確実に明るく見える）
function tileRoad() {
  return emptyTile(0);
}

// 2: 道の縁（左）— 荒野色→縁石(index2, BG内で使える最も暗いトーン)→路面色、と3階調で連続的に繋がる縦帯。
//    最暗色(index3)は弾/キャラ専用に予約するため、BGはここでは使わない。
//    縁石帯はindex2固定で、道幅が変化してもこのタイルが立つ限り必ず視認できる。
function tileEdgeLeft() {
  const t = emptyTile(1); // 外側(荒野側)は荒野と同じトーンで地続きにする
  for (let y = 0; y < 8; y++) {
    setPx(t, 3, y, 2);
    setPx(t, 4, y, 2);
    setPx(t, 5, y, 2);
    setPx(t, 6, y, 0);
    setPx(t, 7, y, 0); // 内側(道側)は路面と同じトーンで地続きにする
  }
  return t;
}

// 3: 道の縁（右）— tileEdgeLeftと左右対称の配色（路面→縁石index2→荒野）
function tileEdgeRight() {
  const t = emptyTile(1); // 外側(荒野側)は荒野と同じトーン
  for (let y = 0; y < 8; y++) {
    setPx(t, 0, y, 0); // 内側(道側)は路面と同じトーン
    setPx(t, 1, y, 0);
    setPx(t, 2, y, 2);
    setPx(t, 3, y, 2);
    setPx(t, 4, y, 2);
  }
  return t;
}

// 4: 岩（荒野の装飾。道の外側にのみ配置される。最暗色は縁石/障害物用に予約し、これは中間トーン）
function tileRock() {
  const t = emptyTile(1);
  const pattern = [
    '..XX....',
    '.XXXX...',
    'XXXXXX..',
    'XXXXXXX.',
    'XXXXXXX.',
    '.XXXXX..',
    '..XXX...',
    '........',
  ];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (pattern[y][x] === 'X') {
        setPx(t, x, y, 2);
      }
    }
  }
  return t;
}

// 5: 轍（道の装飾。道の内側にのみ配置される。路面より少し暗い中間トーンの細線）
function tileRut() {
  const t = emptyTile(0);
  for (let y = 0; y < 8; y++) {
    setPx(t, 2, y, 2);
    setPx(t, 5, y, 2);
  }
  return t;
}

// 6: 柵（荒野の装飾。道の外側にのみ配置される）。最暗色(index3)はBGでは使わないため
// 支柱・横バーとも index2 で統一し、形状(縦2本+横2本)のみでシルエットを作る。
function tileFence() {
  const t = emptyTile(1);
  for (let y = 0; y < 8; y++) {
    setPx(t, 1, y, 2);
    setPx(t, 6, y, 2);
  }
  for (let x = 0; x < 8; x++) {
    setPx(t, x, 2, 2);
    setPx(t, x, 5, 2);
  }
  return t;
}

// 7: 煙（オフロード時の自機演出用。荒野色と同じ透明地に中間トーンのドット雲を置く。
//    点滅表示はgame.js側でスプライトのpush自体を間引くことで行うため、タイル自体は1種類でよい）
function tileSmoke() {
  const t = emptyTile(4); // 4=透明。背景を透かして煙のドットだけ浮かせる
  const pattern = [
    '........',
    '..XX....',
    '.XXXXX..',
    'XXXXXXX.',
    '.XXXXX..',
    '..XXX...',
    '........',
    '........',
  ];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (pattern[y][x] === 'X') {
        setPx(t, x, y, 2);
      }
    }
  }
  return t;
}

// 8: 自弾(リボルバー) — まっすぐ速い弾。細い縦線。最暗色(index3)ではっきり描き、
//    背景(index0-2のみ)から常に浮いて見えるようにする。地は透明(4)。
function tileBulletRevolver() {
  const t = emptyTile(4);
  for (let y = 1; y < 7; y++) {
    setPx(t, 3, y, 3);
    setPx(t, 4, y, 3);
  }
  return addOutline3(t);
}

// 9: 自弾(鉄球) — 遅いが貫通する丸い弾。塗りつぶした円形シルエット。
function tileBulletIronball() {
  const t = emptyTile(4);
  const pattern = [
    '..XXXX..',
    '.XXXXXX.',
    'XXXXXXXX',
    'XXXXXXXX',
    'XXXXXXXX',
    'XXXXXXXX',
    '.XXXXXX.',
    '..XXXX..',
  ];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (pattern[y][x] === 'X') {
        setPx(t, x, y, 3);
      }
    }
  }
  return addOutline3(t);
}

// 10: 自弾(ダイナマイト) — 山なりに投げる爆弾。角ばった四角シルエットで丸弾と区別する。
function tileBulletDynamite() {
  const t = emptyTile(4);
  const pattern = [
    '........',
    '.XXXXXX.',
    '.X....X.',
    '.X.XX.X.',
    '.X.XX.X.',
    '.X....X.',
    '.XXXXXX.',
    '........',
  ];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (pattern[y][x] === 'X') {
        setPx(t, x, y, 3);
      }
    }
  }
  return addOutline3(t);
}

// 11: 敵弾 — 自弾3種のいずれとも異なるひし形シルエット。敵弾専用の単一タイル。
function tileBulletEnemy() {
  const t = emptyTile(4);
  const pattern = [
    '...XX...',
    '..XXXX..',
    '.XXXXXX.',
    'XXXXXXXX',
    'XXXXXXXX',
    '.XXXXXX.',
    '..XXXX..',
    '...XX...',
  ];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (pattern[y][x] === 'X') {
        setPx(t, x, y, 3);
      }
    }
  }
  return addOutline3(t);
}

// 旧フォント(5x7手続き生成)はgbtetrin縁付き4x8フォント(font-data.js + gfx.jsの実行時合成)へ
// 置き換えたため、ここには存在しない。文字はタイルアトラスへ焼かず、raster().blitGlyph()で
// フレーム毎に合成して描く。

// --- 16x16 メタスプライト用（8x8タイル4枚組: 左上/右上/左下/右下） ---

// 4枚組のキャンバス代わりの中間表現を作る（各要素は8x8のUint8Array）
function newQuad() {
  return [emptyTile(0), emptyTile(0), emptyTile(0), emptyTile(0)]; // TL,TR,BL,BR
}

function setPx16(quad, x, y, v) {
  if (x < 0 || x > 15 || y < 0 || y > 15) {
    return;
  }
  const qx = x < 8 ? 0 : 1;
  const qy = y < 8 ? 0 : 1;
  setPx(quad[qy * 2 + qx], x & 7, y & 7, v);
}

// --- 実素材（art/generated/*.js）由来の16x16メタスプライトを4枚組(quad)へ変換する ---

// 16x16の行優先フラット配列(値0..4, 4=透明)をTL/TR/BL/BRの8x8タイル4枚組へ変換する。
function quadFrom16(flat) {
  const quad = newQuad();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      setPx16(quad, x, y, flat[y * 16 + x]);
    }
  }
  return quad;
}

// 32x32の行優先フラット配列から、(ox,oy)を左上とする16x16領域だけを4枚組(quad)へ変換する。
// ボス(boss_rival)の4象限をそれぞれ独立したメタスプライトとして取り出すために使う。
function quadFrom32Region(flat32, ox, oy) {
  const quad = newQuad();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      setPx16(quad, x, y, flat32[(oy + y) * 32 + (ox + x)]);
    }
  }
  return quad;
}

// 自機バギー（実素材: art/raw/player_buggy.png を tools/spritelab_gen.py --convert-art で変換）
function buildPlayerBuggy() {
  return quadFrom16(TILE_PLAYER_BUGGY);
}

// 雑魚敵A（実素材: enemy_bike.png）
function buildEnemyBike() {
  return quadFrom16(TILE_ENEMY_BIKE);
}

// 雑魚敵B（実素材: enemy_car.png）
function buildEnemyRound() {
  return quadFrom16(TILE_ENEMY_CAR);
}

// 障害物: 岩（実素材: obstacle_rock.png）
function buildObstacleRock() {
  return quadFrom16(TILE_OBSTACLE_ROCK);
}

// 障害物: 柵（実素材: obstacle_fence.png）
function buildObstacleFence() {
  return quadFrom16(TILE_OBSTACLE_FENCE);
}

// 障害物: サボテン（実素材: obstacle_cactus.png）
function buildObstacleCactus() {
  return quadFrom16(TILE_OBSTACLE_CACTUS);
}

// 敵: スキャッター（実素材: enemy_scatter.png。段階3で追加）
function buildEnemyScatter() {
  return quadFrom16(TILE_ENEMY_SCATTER);
}

// 敵: ドリフター（実素材: enemy_drifter.png。段階3で追加）
function buildEnemyDrifter() {
  return quadFrom16(TILE_ENEMY_DRIFTER);
}

// 敵: リーパー（実素材: enemy_reaper.png。段階3で追加）
function buildEnemyReaper() {
  return quadFrom16(TILE_ENEMY_REAPER);
}

// 敵: ガンワゴン（実素材: enemy_gunwagon.png。段階3で追加）
function buildEnemyGunwagon() {
  return quadFrom16(TILE_ENEMY_GUNWAGON);
}

// 敵: ホイールソー（実素材: enemy_wheelsaw.png。段階3で追加）
function buildEnemyWheelsaw() {
  return quadFrom16(TILE_ENEMY_WHEELSAW);
}

// 敵: ホッパー（実素材: enemy_hopper.png。段階3グループ2で追加）
function buildEnemyHopper() {
  return quadFrom16(TILE_ENEMY_HOPPER);
}

// 敵: サンドワーム（実素材: enemy_sandworm.png。段階3グループ2で追加）
function buildEnemySandworm() {
  return quadFrom16(TILE_ENEMY_SANDWORM);
}

// 敵: サイドカー（実素材: enemy_sidecar.png。段階3グループ2で追加）
function buildEnemySidecar() {
  return quadFrom16(TILE_ENEMY_SIDECAR);
}

// 敵: マザー（実素材: enemy_mother.png。段階3グループ2で追加）
function buildEnemyMother() {
  return quadFrom16(TILE_ENEMY_MOTHER);
}

// 敵: ミラージュ（実素材: enemy_mirage.png。段階3グループ3で追加）
function buildEnemyMirage() {
  return quadFrom16(TILE_ENEMY_MIRAGE);
}

// 敵: チェイサー（実素材: enemy_chaser.png。段階3グループ3で追加）
function buildEnemyChaser() {
  return quadFrom16(TILE_ENEMY_CHASER);
}

export function buildTiles() {
  const tiles = [];
  tiles.push(tileEmpty()); // 0
  tiles.push(tileRoad()); // 1
  tiles.push(tileEdgeLeft()); // 2
  tiles.push(tileEdgeRight()); // 3
  tiles.push(tileRock()); // 4
  tiles.push(tileRut()); // 5
  tiles.push(tileFence()); // 6
  tiles.push(tileSmoke()); // 7
  tiles.push(tileBulletRevolver()); // 8
  tiles.push(tileBulletIronball()); // 9
  tiles.push(tileBulletDynamite()); // 10
  tiles.push(tileBulletEnemy()); // 11

  // 16x16メタスプライト（4枚組: TL,TR,BL,BR の順で連続配置）
  // ボス(boss_rival.png)は真の32x32素材なので、4象限(TL/TR/BL/BR)をそれぞれ独立した
  // 16x16メタスプライトとして持つ（左右反転で使い回さない。各象限内部はall-or-nothing）。
  const META16_DEFS = [
    ['TILE16_PLAYER', buildPlayerBuggy()],
    ['TILE16_ENEMY_A', buildEnemyBike()],
    ['TILE16_ENEMY_B', buildEnemyRound()],
    ['TILE16_BOSS_TL', quadFrom32Region(TILE_BOSS_RIVAL, 0, 0)],
    ['TILE16_BOSS_TR', quadFrom32Region(TILE_BOSS_RIVAL, 16, 0)],
    ['TILE16_BOSS_BL', quadFrom32Region(TILE_BOSS_RIVAL, 0, 16)],
    ['TILE16_BOSS_BR', quadFrom32Region(TILE_BOSS_RIVAL, 16, 16)],
    ['TILE16_ROCK', buildObstacleRock()],
    ['TILE16_FENCE', buildObstacleFence()],
    ['TILE16_CACTUS', buildObstacleCactus()],
    ['TILE16_EXPLOSION_0', quadFrom16(TILE_EXPLOSION_FRAME0)], // 小
    ['TILE16_EXPLOSION_1', quadFrom16(TILE_EXPLOSION_FRAME1)], // 大
    ['TILE16_EXPLOSION_2', quadFrom16(TILE_EXPLOSION_FRAME2)], // 散
    // 段階3: 敵5種（スキャッター/ドリフター/リーパー/ガンワゴン/ホイールソー）
    ['TILE16_ENEMY_SCATTER', buildEnemyScatter()],
    ['TILE16_ENEMY_DRIFTER', buildEnemyDrifter()],
    ['TILE16_ENEMY_REAPER', buildEnemyReaper()],
    ['TILE16_ENEMY_GUNWAGON', buildEnemyGunwagon()],
    ['TILE16_ENEMY_WHEELSAW', buildEnemyWheelsaw()],
    // 段階3グループ2: 敵4種（ホッパー/サンドワーム/サイドカー/マザー）
    ['TILE16_ENEMY_HOPPER', buildEnemyHopper()],
    ['TILE16_ENEMY_SANDWORM', buildEnemySandworm()],
    ['TILE16_ENEMY_SIDECAR', buildEnemySidecar()],
    ['TILE16_ENEMY_MOTHER', buildEnemyMother()],
    // 段階3グループ3: 敵2種（ミラージュ/チェイサー）
    ['TILE16_ENEMY_MIRAGE', buildEnemyMirage()],
    ['TILE16_ENEMY_CHASER', buildEnemyChaser()],
  ];
  const meta16Ids = {};
  for (const [name, quad] of META16_DEFS) {
    meta16Ids[name] = tiles.length;
    for (const t of quad) {
      tiles.push(t);
    }
  }

  return { tiles, meta16Ids };
}

// buildTiles() 実行前でも参照できるよう、固定の並び順から算出した定数として公開する
// （tiles配列の実個数と同じロジックで導出しているため buildTiles() の結果と一致する）
const META16_ORDER = [
  'TILE16_PLAYER',
  'TILE16_ENEMY_A',
  'TILE16_ENEMY_B',
  'TILE16_BOSS_TL',
  'TILE16_BOSS_TR',
  'TILE16_BOSS_BL',
  'TILE16_BOSS_BR',
  'TILE16_ROCK',
  'TILE16_FENCE',
  'TILE16_CACTUS',
  'TILE16_EXPLOSION_0',
  'TILE16_EXPLOSION_1',
  'TILE16_EXPLOSION_2',
  'TILE16_ENEMY_SCATTER',
  'TILE16_ENEMY_DRIFTER',
  'TILE16_ENEMY_REAPER',
  'TILE16_ENEMY_GUNWAGON',
  'TILE16_ENEMY_WHEELSAW',
  'TILE16_ENEMY_HOPPER',
  'TILE16_ENEMY_SANDWORM',
  'TILE16_ENEMY_SIDECAR',
  'TILE16_ENEMY_MOTHER',
  'TILE16_ENEMY_MIRAGE',
  'TILE16_ENEMY_CHASER',
];
const NUM_FIXED_TILES = 12; // 道路系7枚(0-6) + 煙(7) + 自弾3種(8-10) + 敵弾(11)
const META16_BASE = NUM_FIXED_TILES; // 固定タイル12枚の後ろ（フォントはタイルアトラスに含まれない）
export const TILE_SMOKE = 7; // 8x8単体スプライト用（メタ16ではない）。オフロード演出の煙で使う
export const TILE_BULLET_REVOLVER = 8; // 自弾(リボルバー)専用8x8タイル。最暗色(index3)
export const TILE_BULLET_IRONBALL = 9; // 自弾(鉄球)専用8x8タイル。最暗色(index3)
export const TILE_BULLET_DYNAMITE = 10; // 自弾(ダイナマイト)専用8x8タイル。最暗色(index3)
export const TILE_BULLET_ENEMY = 11; // 敵弾専用8x8タイル。最暗色(index3)
export const TILE16_PLAYER = META16_BASE + META16_ORDER.indexOf('TILE16_PLAYER') * 4;
export const TILE16_ENEMY_A = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_A') * 4;
export const TILE16_ENEMY_B = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_B') * 4;
export const TILE16_BOSS_TL = META16_BASE + META16_ORDER.indexOf('TILE16_BOSS_TL') * 4;
export const TILE16_BOSS_TR = META16_BASE + META16_ORDER.indexOf('TILE16_BOSS_TR') * 4;
export const TILE16_BOSS_BL = META16_BASE + META16_ORDER.indexOf('TILE16_BOSS_BL') * 4;
export const TILE16_BOSS_BR = META16_BASE + META16_ORDER.indexOf('TILE16_BOSS_BR') * 4;
export const TILE16_ROCK = META16_BASE + META16_ORDER.indexOf('TILE16_ROCK') * 4;
export const TILE16_FENCE = META16_BASE + META16_ORDER.indexOf('TILE16_FENCE') * 4;
export const TILE16_CACTUS = META16_BASE + META16_ORDER.indexOf('TILE16_CACTUS') * 4;
export const TILE16_EXPLOSION_0 = META16_BASE + META16_ORDER.indexOf('TILE16_EXPLOSION_0') * 4;
export const TILE16_EXPLOSION_1 = META16_BASE + META16_ORDER.indexOf('TILE16_EXPLOSION_1') * 4;
export const TILE16_EXPLOSION_2 = META16_BASE + META16_ORDER.indexOf('TILE16_EXPLOSION_2') * 4;
export const TILE16_ENEMY_SCATTER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_SCATTER') * 4;
export const TILE16_ENEMY_DRIFTER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_DRIFTER') * 4;
export const TILE16_ENEMY_REAPER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_REAPER') * 4;
export const TILE16_ENEMY_GUNWAGON = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_GUNWAGON') * 4;
export const TILE16_ENEMY_WHEELSAW = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_WHEELSAW') * 4;
export const TILE16_ENEMY_HOPPER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_HOPPER') * 4;
export const TILE16_ENEMY_SANDWORM = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_SANDWORM') * 4;
export const TILE16_ENEMY_SIDECAR = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_SIDECAR') * 4;
export const TILE16_ENEMY_MOTHER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_MOTHER') * 4;
export const TILE16_ENEMY_MIRAGE = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_MIRAGE') * 4;
export const TILE16_ENEMY_CHASER = META16_BASE + META16_ORDER.indexOf('TILE16_ENEMY_CHASER') * 4;
