// input.js — キー入力状態管理（押下/トリガ）
export const K = {
  UP: 1 << 0,
  DOWN: 1 << 1,
  LEFT: 1 << 2,
  RIGHT: 1 << 3,
  A: 1 << 4,
  B: 1 << 5,
  START: 1 << 6,
};

const KEY_MAP = {
  ArrowUp: K.UP,
  KeyW: K.UP,
  ArrowDown: K.DOWN,
  KeyS: K.DOWN,
  ArrowLeft: K.LEFT,
  KeyA: K.LEFT,
  ArrowRight: K.RIGHT,
  KeyD: K.RIGHT,
  KeyZ: K.A,
  KeyJ: K.A,
  KeyX: K.B,
  KeyK: K.B,
  Enter: K.START,
};

let heldState = 0;
let pressedState = 0; // このフレームで新規に押されたビット

// ビットごとの参照カウント。キーボードとタッチなど複数の入力源が同じビットを
// 同時に押している場合でも、片方が離れただけでは解除されないようにする。
const refCounts = new Map();

// 押下/解放の共通経路。キーボードもタッチ(touch.js)もここを通ることで、
// isDown/isPressed(押下エッジ)の意味を入力源に関わらず一致させる。
export function pressButton(bit) {
  const c = refCounts.get(bit) || 0;
  refCounts.set(bit, c + 1);
  if (c === 0) {
    if (!(heldState & bit)) {
      pressedState |= bit;
    }
    heldState |= bit;
  }
}

export function releaseButton(bit) {
  const c = refCounts.get(bit) || 0;
  if (c === 0) {
    return;
  }
  const nc = c - 1;
  refCounts.set(bit, nc);
  if (nc === 0) {
    heldState &= ~bit;
  }
}

// キーボードのオートリピート(keydown連射)で参照カウントが多重加算されないよう、
// 物理キーごとに「すでに押下中か」を別途管理する。
const heldKeys = new Set();

function onKeyDown(e) {
  const bit = KEY_MAP[e.code];
  if (bit === undefined) {
    return;
  }
  e.preventDefault();
  if (heldKeys.has(e.code)) {
    return; // OSのキーリピートによる連続keydownは無視
  }
  heldKeys.add(e.code);
  pressButton(bit);
}

function onKeyUp(e) {
  const bit = KEY_MAP[e.code];
  if (bit === undefined) {
    return;
  }
  e.preventDefault();
  heldKeys.delete(e.code);
  releaseButton(bit);
}

window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

// ソフトカート版でbrickboy側が入力を供給する場合に呼ぶ。bagulas自身のwindowキーリスナを外し、
// 同じ物理キーがbrickboyとbagulasで二重に数えられるのを防ぐ。
export function detachKeyboard() {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  heldKeys.clear();
}

// タッチ判定の単一情報源。index.htmlのCSSとtouch.jsのコントロール初期化、
// game.jsの案内文(TAP START / PRESS ENTER)が、すべてここを参照して一致させる。
// pointer:coarseに加えmaxTouchPoints>0も見るのは、トラックパッド接続iPadなど
// pointer:coarseがfalseになる端末でも判定できるようにするため。
let touchDetected =
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);

export function isTouch() {
  return touchDetected;
}

// 保険経路(touch.js): 実際にpointerType==='touch'のpointerdownを観測した時点で
// 事後的に確定させる(後から指で触った場合の救済)。
export function markTouchDetected() {
  touchDetected = true;
}

export function isDown(k) {
  return (heldState & k) !== 0;
}

export function isPressed(k) {
  return (pressedState & k) !== 0;
}

// 1フレームの終わりにトリガ状態をクリアする
export function endFrame() {
  pressedState = 0;
}
