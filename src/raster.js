// raster.js — ラスタバックエンドの差し込み口。gfx.js はここ経由でのみ「canvasを触る部分」を呼ぶ。
let backend = null;

export function setRaster(b) {
  backend = b;
}

export function raster() {
  return backend;
}
