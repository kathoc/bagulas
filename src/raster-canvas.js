// raster-canvas.js — canvasラスタバックエンド（gfx.jsが持っていたcanvas実装を逐語で移植）
export const PALETTE = ['#9bbc0f', '#8bac0f', '#306230', '#0f380f'];

const SCREEN_W = 160;
const SCREEN_H = 144;

let displayCanvas = null;
let displayCtx = null;
let offCanvas = null;
let offCtx = null;
let atlasCanvas = null;
let atlasCanvasInv = null; // パレット反転版アトラス（被弾白フラッシュ用。起動時に1回だけ焼く）
let glyphCanvas = null; // 文字描画用スクラッチ(8x8)。initで1回だけ確保し、毎フレーム使い回す
let glyphCtx = null;
let glyphImageData = null;

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

// タイル値 4 = 透明（スプライト/障害物用の生成アートのみが持つ。BG用の手続き生成タイルは0-3のみ）。
// 通常アトラスでもパレット反転アトラスでも、透明texelはalpha=0で焼く（反転しても透明のまま）。
const TILE_TRANSPARENT = 4;
const RGB_CACHE = PALETTE.map(hexToRgb);

function buildAtlas(tiles, invert) {
  const canvas = document.createElement('canvas');
  canvas.width = tiles.length * 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(canvas.width, 8);
  const rgbCache = RGB_CACHE;
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = tile[y * 8 + x];
        const px = i * 8 + x;
        const idx = (y * canvas.width + px) * 4;
        if (v === TILE_TRANSPARENT) {
          imgData.data[idx] = 0;
          imgData.data[idx + 1] = 0;
          imgData.data[idx + 2] = 0;
          imgData.data[idx + 3] = 0; // 反転版でも不透明色にせずそのまま透明にする
          continue;
        }
        const rgb = rgbCache[invert ? 3 - v : v];
        imgData.data[idx] = rgb.r;
        imgData.data[idx + 1] = rgb.g;
        imgData.data[idx + 2] = rgb.b;
        imgData.data[idx + 3] = 255;
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// 8x8タイル1枚を(px,py)へ描く。flags: bit0=X反転, bit1=Y反転
// pushSprite / pushMeta16 / BG系で共有する（毎フレームのピクセル操作をせず drawImage の変換のみで反転する）
function blitTile(atlas, tileId, px, py, flags) {
  const flipX = (flags & 1) !== 0;
  const flipY = (flags & 2) !== 0;

  if (!flipX && !flipY) {
    offCtx.drawImage(atlas, tileId * 8, 0, 8, 8, px, py, 8, 8);
  } else {
    offCtx.save();
    offCtx.translate(px + (flipX ? 8 : 0), py + (flipY ? 8 : 0));
    offCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    offCtx.drawImage(atlas, tileId * 8, 0, 8, 8, 0, 0, 8, 8);
    offCtx.restore();
  }
}

function computeScale() {
  const availW = window.innerWidth;
  const availH = window.innerHeight;
  let scale = Math.min((availW / SCREEN_W) | 0, (availH / SCREEN_H) | 0);
  if (scale < 1) {
    scale = 1;
  }
  if (scale > 6) {
    scale = 6;
  }
  return scale;
}

function resizeDisplay() {
  if (!displayCanvas) {
    return;
  }
  const scale = computeScale();
  displayCanvas.width = SCREEN_W * scale;
  displayCanvas.height = SCREEN_H * scale;
  displayCtx.imageSmoothingEnabled = false;
}

// tiles: buildTiles()が返すタイル配列（Uint8Array(64)、値0..4）。canvas: 表示先の<canvas>要素。
export function init(tiles, canvas) {
  displayCanvas = canvas;
  displayCtx = canvas.getContext('2d');
  displayCtx.imageSmoothingEnabled = false;

  offCanvas = document.createElement('canvas');
  offCanvas.width = SCREEN_W;
  offCanvas.height = SCREEN_H;
  offCtx = offCanvas.getContext('2d');
  offCtx.imageSmoothingEnabled = false;

  atlasCanvas = buildAtlas(tiles, false);
  atlasCanvasInv = buildAtlas(tiles, true); // 被弾白フラッシュ用の反転アトラスを起動時に1回だけ焼く

  glyphCanvas = document.createElement('canvas');
  glyphCanvas.width = 8;
  glyphCanvas.height = 8;
  glyphCtx = glyphCanvas.getContext('2d');
  glyphCtx.imageSmoothingEnabled = false;
  glyphImageData = glyphCtx.createImageData(8, 8);

  resizeDisplay();
  window.addEventListener('resize', resizeDisplay);
}

export function blit(tileId, px, py, flags, invert) {
  const atlas = invert ? atlasCanvasInv : atlasCanvas;
  blitTile(atlas, tileId, px, py, flags);
}

// 任意の8x8シェード配列(値0..3、4=透明)を(px,py)へ直接描く。文字描画専用
// (gfx.jsが実行時合成したフォントタイル用)。スクラッチcanvas/ImageDataはinit()で1回だけ確保済みで、
// ここでは中身の書き換え+putImageData+drawImageのみ行う(毎フレームの確保なし)。
export function blitGlyph(tile8x8, px, py) {
  const data = glyphImageData.data;
  for (let i = 0; i < 64; i++) {
    const v = tile8x8[i];
    const idx = i * 4;
    if (v === TILE_TRANSPARENT) {
      data[idx + 3] = 0;
      continue;
    }
    const rgb = RGB_CACHE[v];
    data[idx] = rgb.r;
    data[idx + 1] = rgb.g;
    data[idx + 2] = rgb.b;
    data[idx + 3] = 255;
  }
  glyphCtx.putImageData(glyphImageData, 0, 0);
  offCtx.drawImage(glyphCanvas, 0, 0, 8, 8, px, py, 8, 8);
}

export function fillRect(px, py, w, h, colorIndex) {
  offCtx.fillStyle = PALETTE[colorIndex];
  offCtx.fillRect(px, py, w, h);
}

export function present() {
  displayCtx.imageSmoothingEnabled = false;
  displayCtx.drawImage(
    offCanvas,
    0,
    0,
    SCREEN_W,
    SCREEN_H,
    0,
    0,
    displayCanvas.width,
    displayCanvas.height
  );
}
