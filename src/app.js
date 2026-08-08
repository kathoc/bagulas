// app.js — 固定ステップの本体（旧main.jsのselfTestAim16/seed(0x2f)/scrollY/update()/render()を逐語で移植）。
// フレーム駆動そのものはしない。ブラウザ版はmain.jsが、ソフトカート版はsoftcart.jsが呼び出す。
import { DIR16, aim16, f } from './fixed.js';
import { seed } from './rng.js';
import { clearFrame, drawBG, present } from './gfx.js';
import { initGame, updateGame, drawGame, getScrollSpeed } from './game.js';

let scrollY = 0; // 8.8固定小数点

function selfTestAim16() {
  let ok = true;
  for (let i = 0; i < DIR16.length; i++) {
    const v = DIR16[i];
    const idx = aim16(v.dx, v.dy);
    if (idx !== i) {
      ok = false;
      console.log('AIM16 MISMATCH index=' + i + ' got=' + idx + ' dx=' + v.dx + ' dy=' + v.dy);
    }
  }
  console.log(ok ? 'AIM16 OK' : 'AIM16 FAILED');
}

// initGfx()（バックエンド初期化）は呼び出し側が別途行う。ここはゲーム側の初期化のみ。
export function initApp() {
  selfTestAim16();
  seed(0x2f);
  initGame();
  scrollY = 0;
}

export function step() {
  // scrollSpeedはgame.js側の状態（自機死亡演出中は減速→停止、リスポーン時は加速して復帰する）。
  // ここではgetScrollSpeed()で毎フレーム取得するだけで、ループ制御自体は一切変更しない。
  scrollY += getScrollSpeed();
  updateGame(scrollY);
}

export function render() {
  clearFrame();
  drawBG(scrollY);
  drawGame();
  present();
}
