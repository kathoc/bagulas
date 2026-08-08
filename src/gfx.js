// gfx.js — パレット・タイルアトラス・BG描画・スプライト(OAM)上限管理・文字描画
import { toPx } from './fixed.js';
import { buildTiles } from './tiles.js';
import { rndRange } from './rng.js';
import { raster } from './raster.js';
import { GFX_FONT } from './font-data.js';

const SCREEN_W = 160;
const SCREEN_H = 144;
const TILE_W = 20; // SCREEN_W / 8
const MAP_ROWS = 64; // タイルマップのリングバッファ縦幅

const SPRITE_MAX = 40;
const SPRITE_MAX_PER_LINE = 10;

let tileList = null;

// --- gbtetrin縁付き4x8フォント(text_glyph/glyph_pair/compose_tile/spill_leftの逐語移植) ---
// gbtetrin(~/Playground/gbtetrin/src/main.c)は8x8タイルへVRAM経由で焼くが、bagulasは
// raster().blitGlyph()でフレームバッファ/canvasへ直接合成する。スクラッチはinitで確保済みの
// ものをここで使い回す(frame内でのnew/配列生成禁止のため、モジュールスコープに固定長で置く)。
const FONT_G = new Uint8Array(8); // g[y]: 2文字ぶんの字形(8bit行、左4bit+右4bit)
const FONT_O = new Uint8Array(8); // o[y]: 8方向の縁取り(8bit行)
const FONT_SP = new Uint8Array(8); // sp[y]: 左隣タイルへ漏れる1px(0/1)
const FONT_GLYPH_TILE = new Uint8Array(64); // 合成した8x8(値: 3=字形, 0=縁, 4=透明)
const FONT_SPILL_TILE = new Uint8Array(64); // 左隣タイルの右端1列だけを更新するための8x8(他は常に透明)

function initFontScratch() {
  // 列0..6は常に透明(4)のまま固定。列7(右端)だけ毎回書き換える。
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 7; x++) {
      FONT_SPILL_TILE[y * 8 + x] = 4;
    }
  }
}
initFontScratch();

// text_glyph(c): '0'-'9'→0..9、'A'-'Z'/'a'-'z'→10..35、'.'→36、'-'→37、'>'→38、
// '\''→40、'"'→41、それ以外(スペース含む)→39
function textGlyph(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (code >= 65 && code <= 90) {
    return code - 65 + 10;
  }
  if (code >= 97 && code <= 122) {
    return code - 97 + 10;
  }
  if (ch === '.') {
    return 36;
  }
  if (ch === '-') {
    return 37;
  }
  if (ch === '>') {
    return 38;
  }
  if (ch === "'") {
    return 40;
  }
  if (ch === '"') {
    return 41;
  }
  return 39;
}

// glyph_pair()のtext_decor==1(8方向の縁取り)分岐を逐語移植。
// Cのuint8_tは演算のたびに8bitへ切り捨てられるため、JSでは各ステップを明示的に & 0xff する。
function glyphPair(cl, cr) {
  const li = textGlyph(cl) << 3;
  const ri = textGlyph(cr) << 3;
  for (let y = 0; y < 8; y++) {
    const l = GFX_FONT[li + y] & 0x0f;
    const r = GFX_FONT[ri + y] & 0x0f;
    FONT_G[y] = ((l << 4) | r) & 0xff;
  }
  for (let y = 0; y < 8; y++) {
    let v = FONT_G[y];
    if (y > 0) {
      v |= FONT_G[y - 1];
    }
    if (y < 7) {
      v |= FONT_G[y + 1];
    }
    v &= 0xff;
    const shl = (v << 1) & 0xff;
    const shr = (v >> 1) & 0xff;
    FONT_O[y] = (v | shl | shr) & (~FONT_G[y] & 0xff) & 0xff;
    FONT_SP[y] = (v & 0x80) !== 0 ? 1 : 0;
  }
}

// タイルマップ（道の生成）
const mapData = new Uint8Array(TILE_W * MAP_ROWS);

const TILE_EMPTY = 0;
const TILE_ROAD = 1;
const TILE_EDGE_L = 2;
const TILE_EDGE_R = 3;
const TILE_ROCK = 4;
const TILE_RUT = 5;
const TILE_FENCE = 6;

let spriteUsed = 0;
const lineCounts = new Int32Array(SCREEN_H);

// tile id -> オフロード判定。荒野色(EMPTY)・岩・柵・遷移境界(EDGE_L/R)はオフロード扱い。
// 路面(ROAD)・轍(RUT)はオンロード扱い。
const OFFROAD_TILE = [true, false, true, true, true, false, true]; // index = TILE_EMPTY..TILE_FENCE (0..6)

const MAX_OFFROAD_EACH = 5; // 片側オフロードの最大列数(20列中)。左右合計max10列、中央は常に最低10列(80px)オンロード保証
const MIN_RUN_ROWS = 6; // オフロード形状が最低これだけの行数持続する（1タイルごとのチラつき防止）
const RUN_JITTER_ROWS = 10; // runの持続行数の追加ばらつき幅（rndRangeへ渡す）

export const SAFE_ONROAD_LEFT_PX = MAX_OFFROAD_EACH * 8; // 常にオンロード保証される左端px
export const SAFE_ONROAD_RIGHT_PX = (TILE_W - MAX_OFFROAD_EACH) * 8; // 常にオンロード保証される右端px（この値未満が安全域）

function buildMap() {
  let leftW = 0;
  let rightW = 0;
  let runRemain = 0;
  for (let row = 0; row < MAP_ROWS; row++) {
    if (runRemain <= 0) {
      runRemain = MIN_RUN_ROWS + rndRange(RUN_JITTER_ROWS);
      leftW = rndRange(MAX_OFFROAD_EACH + 1); // 0..MAX_OFFROAD_EACH
      rightW = rndRange(MAX_OFFROAD_EACH + 1);
    }
    runRemain -= 1;
    for (let col = 0; col < TILE_W; col++) {
      let tile;
      if (leftW > 0 && col < leftW - 1) {
        // 左オフロード帯（縁より外側）: 荒野色地に低確率で岩/柵の装飾
        tile = rndRange(24) === 0 ? TILE_ROCK : (rndRange(37) === 0 ? TILE_FENCE : TILE_EMPTY);
      } else if (leftW > 0 && col === leftW - 1) {
        tile = TILE_EDGE_L; // 左オフロード帯の内側境界(オンロードとの遷移マーカー)
      } else if (rightW > 0 && col === TILE_W - rightW) {
        tile = TILE_EDGE_R; // 右オフロード帯の内側境界
      } else if (rightW > 0 && col > TILE_W - rightW) {
        tile = rndRange(24) === 0 ? TILE_ROCK : (rndRange(37) === 0 ? TILE_FENCE : TILE_EMPTY);
      } else {
        // オンロード（中央帯。左右のオフロード帯に挟まれた本体部分）
        tile = rndRange(9) === 0 ? TILE_RUT : TILE_ROAD;
      }
      mapData[row * TILE_W + col] = tile;
    }
  }
}

// canvasArgはバックエンド固有の引数（canvasバックエンドなら<canvas>要素、fbバックエンドならUint16Arrayバッファ）。
// gfx.js自身はその中身を解釈せず、raster().init()へそのまま渡す。
export function initGfx(canvasArg) {
  const built = buildTiles();
  tileList = built.tiles;

  raster().init(tileList, canvasArg);

  buildMap();
}

export function drawBG(scrollY) {
  // 前進=マップが画面下方向へ流れる。scrollY増加で表示行を負方向へ進める
  const scrollPx = -toPx(scrollY);
  const rowIndex = scrollPx >> 3;
  const offsetY = scrollPx & 7;

  const rowsToDraw = (SCREEN_H >> 3) + 2; // 端の半端タイル分を余分に描く
  for (let sy = 0; sy < rowsToDraw; sy++) {
    let mapRow = (rowIndex + sy) % MAP_ROWS;
    if (mapRow < 0) {
      mapRow += MAP_ROWS;
    }
    const destY = sy * 8 - offsetY;
    if (destY <= -8 || destY >= SCREEN_H) {
      continue;
    }
    for (let col = 0; col < TILE_W; col++) {
      const tileId = mapData[mapRow * TILE_W + col];
      raster().blit(tileId, col * 8, destY, 0, false);
    }
  }
}

export function pushSprite(px, py, tileId, flags) {
  if (spriteUsed >= SPRITE_MAX) {
    return false;
  }

  // 走査線ごとの上限チェック（py..py+7、画面外の行は無視）
  for (let y = py; y < py + 8; y++) {
    if (y < 0 || y >= SCREEN_H) {
      continue;
    }
    if (lineCounts[y] >= SPRITE_MAX_PER_LINE) {
      return false; // このスプライトは描画せず捨てる
    }
  }

  for (let y = py; y < py + 8; y++) {
    if (y < 0 || y >= SCREEN_H) {
      continue;
    }
    lineCounts[y] += 1;
  }
  spriteUsed += 1;

  raster().blit(tileId, px, py, flags, false);

  return true;
}

// 16×16メタスプライト（8x8タイル4枚: tileId0から連続4枚を左上/右上/左下/右下の順）
// all-or-nothing: 40個上限・走査線10個上限を4枚すべて満たせる場合のみ描く。
// 1枚でも置けないなら4枚とも描かず、カウンタも一切変更しない（キャラが半分欠けるのを防ぐ）。
export function pushMeta16(px, py, tileId0, flags, palInvert) {
  // 事前チェック（状態は変更しない）: スプライト総数
  if (spriteUsed + 4 > SPRITE_MAX) {
    return false;
  }
  // 事前チェック: 上段(TL+TR)は同じy範囲に2枚、下段(BL+BR)も同じy範囲に2枚乗る
  for (let band = 0; band < 2; band++) {
    const y0 = py + band * 8;
    for (let y = y0; y < y0 + 8; y++) {
      if (y < 0 || y >= SCREEN_H) {
        continue;
      }
      if (lineCounts[y] + 2 > SPRITE_MAX_PER_LINE) {
        return false; // 1枚でも置けないので4枚とも描かずカウンタも変更しない
      }
    }
  }

  // ここまで来たら確定して描画する
  for (let band = 0; band < 2; band++) {
    const y0 = py + band * 8;
    for (let y = y0; y < y0 + 8; y++) {
      if (y < 0 || y >= SCREEN_H) {
        continue;
      }
      lineCounts[y] += 2;
    }
  }
  spriteUsed += 4;

  const flipX = (flags & 1) !== 0;
  const flipY = (flags & 2) !== 0;

  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      // flags のX/Y反転を尊重し、位置に応じて元のタイル配置順も入れ替える
      const srcRow = flipY ? 1 - row : row;
      const srcCol = flipX ? 1 - col : col;
      const subtile = tileId0 + srcRow * 2 + srcCol;
      raster().blit(subtile, px + col * 8, py + row * 8, flags, palInvert);
    }
  }

  return true;
}

// 障害物用: 16×16をBGレイヤへ直接描く。スプライト枠(40/10)を一切消費しない
export function drawBGObject(px, py, tileId0) {
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const subtile = tileId0 + row * 2 + col;
      raster().blit(subtile, px + col * 8, py + row * 8, 0, false);
    }
  }
}

export function spriteBudgetLeft() {
  return SPRITE_MAX - spriteUsed;
}

export function isOffRoadAt(scrollY, px, py) {
  const scrollPx = -toPx(scrollY);
  const offsetY = scrollPx & 7;
  const rowIndex = scrollPx >> 3;
  const sy = (py + offsetY) >> 3;
  let mapRow = (rowIndex + sy) % MAP_ROWS;
  if (mapRow < 0) {
    mapRow += MAP_ROWS;
  }
  let col = px >> 3;
  if (col < 0) {
    col = 0;
  }
  if (col >= TILE_W) {
    col = TILE_W - 1;
  }
  const tile = mapData[mapRow * TILE_W + col];
  return OFFROAD_TILE[tile];
}

// HUD等の背景に敷く単色の帯（アルファ/グラデーションなし。フラット単色矩形のみ）
export function drawSolidRect(px, py, w, h, colorIndex) {
  raster().fillRect(px, py, w, h, colorIndex);
}

// 4px/字。2文字で8pxの1タイルへ縁付き字形を実行時合成して描く
// (text_glyph/glyph_pair/compose_tile/spill_leftの逐語移植、gbtetrin ~/Playground/gbtetrin/src/main.c)。
// 奇数文字数のときは右側をスペース(glyph 39)扱いにする。
export function drawText(px, py, str) {
  const n = str.length;
  const pairs = (n + 1) >> 1;
  for (let i = 0; i < pairs; i++) {
    const cl = str[i * 2];
    const cr = i * 2 + 1 < n ? str[i * 2 + 1] : ' ';
    glyphPair(cl, cr);

    let anySpill = false;
    for (let y = 0; y < 8; y++) {
      const gv = FONT_G[y];
      const ov = FONT_O[y];
      const row = y * 8;
      for (let x = 0; x < 8; x++) {
        const bit = 1 << (7 - x);
        if (gv & bit) {
          FONT_GLYPH_TILE[row + x] = 3;
        } else if (ov & bit) {
          FONT_GLYPH_TILE[row + x] = 0;
        } else {
          FONT_GLYPH_TILE[row + x] = 4;
        }
      }
      FONT_SPILL_TILE[row + 7] = FONT_SP[y] ? 0 : 4;
      anySpill = anySpill || FONT_SP[y] !== 0;
    }

    const tileX = px + i * 8;
    raster().blitGlyph(FONT_GLYPH_TILE, tileX, py);
    if (anySpill) {
      // 直前タイルの右端1px(タイル左端の1px手前)へ縁の漏れを書く。画面外なら各バックエンドがクリップする。
      raster().blitGlyph(FONT_SPILL_TILE, tileX - 8, py);
    }
  }
}

export function clearFrame() {
  spriteUsed = 0;
  lineCounts.fill(0);
  raster().fillRect(0, 0, SCREEN_W, SCREEN_H, 0);
}

export function present() {
  raster().present();
}
