// softcart.js — brickboyのソフトカート契約に合わせた入口。DOMに依存しない。
// ゲーム本体はapp.js/gfx.jsをそのまま使い、ラスタだけraster-fbへ差し替える。
import { setRaster } from './raster.js';
import * as fbRaster from './raster-fb.js';
import { initGfx } from './gfx.js';
import { initApp, step, render } from './app.js';
import { pressButton, releaseButton, endFrame, detachKeyboard, K } from './input.js';

export const meta = { title: 'BAGULAS' };

let Button = null;
let mapTable = null; // [[brickboyのビット位置, bagulasのK.*], ...]。init時に1回だけ作る（frame()内では作らない）
let prevMask = 0; // 前フレームのjoypadビットマスク（エッジ検出用）

// brickboyの Button（Right/Left/Up/Down/A/B/Select/Start）→ bagulasの K.* 対応表。
// Start → K.START。Selectは対応なし。
function buildButtonMap() {
  const table = [];
  table.push([Button.Right, K.RIGHT]);
  table.push([Button.Left, K.LEFT]);
  table.push([Button.Up, K.UP]);
  table.push([Button.Down, K.DOWN]);
  table.push([Button.A, K.A]);
  table.push([Button.B, K.B]);
  table.push([Button.Start, K.START]);
  return table;
}

export function init(api) {
  Button = api.Button;

  setRaster(fbRaster);
  initGfx(api.fb); // gfx.jsのinitGfx()経由でraster().init(tileList, api.fb)が呼ばれる
  initApp();

  detachKeyboard();

  mapTable = buildButtonMap();
  prevMask = 0;
}

// brickboy側が59.7Hzで1回呼ぶ。1呼び出し=現行ループの1ステップに相当。
// 「joypad反映 → step() → endFrame() → render()」の順で、
// main.jsのrAFループが update() の後・render() の前に endFrame() を呼ぶのと同じ意味にする。
export function frame(joypad) {
  // joypadはJoypadState（brickboy側で毎フレーム使い回される同一オブジェクト）。
  // 生のビットマスクはjoypad.bitsで、ビット位置は 1 << Button。
  const bits = joypad.bits;
  for (let i = 0; i < mapTable.length; i++) {
    const pair = mapTable[i];
    const mask = 1 << pair[0];
    const wasDown = (prevMask & mask) !== 0;
    const isDown = (bits & mask) !== 0;
    if (isDown && !wasDown) {
      pressButton(pair[1]);
    } else if (!isDown && wasDown) {
      releaseButton(pair[1]);
    }
  }
  prevMask = bits;

  step();
  endFrame();
  render();
}
