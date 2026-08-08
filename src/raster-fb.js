// raster-fb.js — フレームバッファへ直接書くラスタバックエンド（ソフトカート/brickboy用）。
// タイルはbuildTiles()が返すUint8Array(64)（値0..4、4=透明）をそのまま保持し、canvasへは焼かない。
const SCREEN_W = 160;
const SCREEN_H = 144;
const TILE_TRANSPARENT = 4;

let tiles = null;
let fb = null; // Uint16Array(160*144)。値は shade 0..3。initで受け取った参照をそのまま使い、確保はしない。

// tiles: buildTiles()が返すタイル配列。buffer: 呼び出し側(brickboy)が確保したUint16Array(160*144)。
export function init(tileList, buffer) {
  tiles = tileList;
  fb = buffer;
}

// 8x8タイル1枚を(px,py)へ書く。flags: bit0=X反転, bit1=Y反転。invert: 被弾白フラッシュ用の 3-v 反転。
// 値4(透明)は反転せず、書き込まない（現行raster-canvasのbuildAtlasと同じ扱い）。画面外は必ずクリップする。
export function blit(tileId, px, py, flags, invert) {
  const tile = tiles[tileId];
  const flipX = (flags & 1) !== 0;
  const flipY = (flags & 2) !== 0;

  for (let y = 0; y < 8; y++) {
    const dy = py + y;
    if (dy < 0 || dy >= SCREEN_H) {
      continue;
    }
    const sy = flipY ? 7 - y : y;
    const rowOff = dy * SCREEN_W;
    for (let x = 0; x < 8; x++) {
      const dx = px + x;
      if (dx < 0 || dx >= SCREEN_W) {
        continue;
      }
      const sx = flipX ? 7 - x : x;
      const v = tile[sy * 8 + sx];
      if (v === TILE_TRANSPARENT) {
        continue;
      }
      fb[rowOff + dx] = invert ? 3 - v : v;
    }
  }
}

// 任意の8x8シェード配列(値0..3、4=透明)を(px,py)へ直接書く。文字描画専用
// (gfx.jsが実行時合成したフォントタイル用)。既存タイルアトラスは経由しない。反転は使わない。
export function blitGlyph(tile8x8, px, py) {
  for (let y = 0; y < 8; y++) {
    const dy = py + y;
    if (dy < 0 || dy >= SCREEN_H) {
      continue;
    }
    const rowOff = dy * SCREEN_W;
    const srcRow = y * 8;
    for (let x = 0; x < 8; x++) {
      const dx = px + x;
      if (dx < 0 || dx >= SCREEN_W) {
        continue;
      }
      const v = tile8x8[srcRow + x];
      if (v === TILE_TRANSPARENT) {
        continue;
      }
      fb[rowOff + dx] = v;
    }
  }
}

export function fillRect(px, py, w, h, colorIndex) {
  for (let y = 0; y < h; y++) {
    const dy = py + y;
    if (dy < 0 || dy >= SCREEN_H) {
      continue;
    }
    const rowOff = dy * SCREEN_W;
    for (let x = 0; x < w; x++) {
      const dx = px + x;
      if (dx < 0 || dx >= SCREEN_W) {
        continue;
      }
      fb[rowOff + dx] = colorIndex;
    }
  }
}

export function present() {
  // no-op: フレームバッファはbrickboy側が読む
}
