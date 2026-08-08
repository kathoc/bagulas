// main.js — ブラウザ版の駆動（canvasバックエンド選択 + 固定ステップrAFループ）。
// ゲーム本体の初期化/更新/描画はapp.jsへ、canvas実装はraster-canvas.jsへ移した。
import { endFrame } from './input.js';
import { initGfx } from './gfx.js';
import { setRaster } from './raster.js';
import * as canvasRaster from './raster-canvas.js';
import { initApp, step, render } from './app.js';

const STEP_MS = 1000 / 60; // 固定ステップ幅（≒16ms）
const MAX_CATCHUP = 1; // 重い場面でも弾だけワープさせず、ロジック全体を一緒にスローにする（実機GB風）

function main() {
  setRaster(canvasRaster);
  // initApp()はseed(0x2f)を含む。initGfx()内のbuildMap()がRNGを消費するため、
  // 必ずinitGfx()より先に呼ぶ（RNG消費順を変えないため。initGameはRNGを消費しないので
  // initGfxとの前後関係はどちらでも結果は同じ）。
  initApp();

  const canvas = document.getElementById('screen');
  initGfx(canvas);

  let last = performance.now();
  let acc = 0;

  function frame(now) {
    let delta = now - last;
    last = now;
    if (delta > 250) {
      delta = 250; // タブ非アクティブ復帰などの巨大デルタを抑制
    }
    acc += delta;
    if (acc > STEP_MS) {
      acc = STEP_MS; // 1ステップ分を超える積み残しはクランプして捨てる（弾だけワープさせない）
    }

    let steps = 0;
    while (acc >= STEP_MS && steps < MAX_CATCHUP) {
      step();
      acc -= STEP_MS;
      steps += 1;
    }

    // 入力トリガ(押下エッジ)は「ロジックが1ステップ実行されたとき」だけクリアする。
    // 無条件にクリアすると、update()が走らなかったフレーム(acc<STEP_MS。高リフレッシュ
    // レート環境や計測ジッタで普通に起きる)で押されたボタンが、一度も読まれないまま
    // 捨てられてしまう（Enterでゲームが始まらない等）。
    if (steps > 0) {
      endFrame();
    }
    render();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();
