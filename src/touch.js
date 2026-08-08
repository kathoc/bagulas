// touch.js — 画面タッチ用の入力レイヤ(「適応原点・絶対式」十字キー)。
//
// 逐語移植元: ~/Playground/brickboy/src/ui/input.ts (本体側、1675行)。
// KEY_MAP と TouchGamepad を、TypeScript の型注釈だけを取り除いて機械的に
// JavaScript へ移した。定数・関数・コメント(日本語/英語とも)は一切削らず、
// 処理順序も変えていない。唯一の意図的な改変は Button 識別子で、下記の
// Button オブジェクトで本プロジェクトの K ビットへ差し替えている(README が
// これを唯一の想定改変点としている)。Select に対応するビットは本プロジェクトに
// 無いため、定義自体は残しつつ(削除しない)、どの K ビットにも接続していない。
//
// 以下、input.ts 冒頭のコメントをそのまま(原文どおり)残す:
//
// Input (Phase C1): an on-screen touch gamepad plus the desktop keyboard map,
// both feeding the same joypad. Pointer Events give unified mouse+touch, real
// multi-touch (several buttons at once), and pointer capture so a press that
// slides off its button still releases cleanly.
//
// A single per-button reference count unifies every source (multiple fingers on
// one button, a diagonal that engages two D-pad directions, and the keyboard):
// gb.setButton fires only on the 0<->1 edge, and the same edge drives the visual
// pressed state — so keyboard play lights up the on-screen buttons too.
//
// D-pad model — "adaptive-origin absolute pad". On a flat screen there is no
// tactile landmark, so the thumb's position estimate is dead-reckoned in the
// hand frame and drifts away from the screen frame over time; the mismatch bites
// at direction changes. To fight that without forcing the user to look:
//   - touchdown reads direction ABSOLUTELY from the pad's current home (tapping
//     the up arm gives Up instantly — no floating "tap does nothing" penalty);
//   - every TOUCHDOWN feeds a running estimate of where the thumb rests, and the
//     home is eased toward it before the direction is read. This is what makes a
//     tap-only player calibrate at all: they never generate a pointermove, so a
//     model that only learns from motion learns nothing from them forever;
//   - while a finger is down, calibration runs on a CLOCK (rAF), not on pointer
//     events, so a dead-still hold corrects at the same rate as a jittering one;
//   - home calibration eases the pad toward the thumb while it is nearly still: at
//     neutral it recentres both axes; while ANY direction is held — cardinal and
//     diagonal alike, one identical law — it cancels the perpendicular drift,
//     keeping the press on-axis. It deliberately does NOT pull along the press
//     axis: an along-pull walks the origin out from under the thumb, so returning
//     to rest then reads as a direction and the next tap lands in the deadzone.
//     On a direction CHANGE the home relaxes partway toward the ESTIMATED REST
//     POINT, so the new direction reads from the best available reference instead
//     of the old one's specialised drift; after the last finger lifts it EASES
//     (never snaps) back to centre, so a quick re-tap stays consistent with what
//     was just used while a pause returns to a clean start.
//     Double-clamped to the viewport and a max offset (can't leave screen);
//   - a velocity-adaptive deadzone (large when still → resist tremor, small when
//     fast → crisp flicks/reversals) plus cardinal-biased angular sectors with
//     hysteresis make "straight" easy and accidental diagonals rare.
import { K, pressButton, releaseButton, isTouch, markTouchDetected } from './input.js';

// 唯一許可された改変点: Button 識別子を本プロジェクトの K ビットへ差し替える。
// Select に対応するビットは本プロジェクトに無いため、定義は残しつつ(削除しない)
// null として、どの K ビットにも接続しない。
const Button = {
  Right: K.RIGHT,
  Left: K.LEFT,
  Up: K.UP,
  Down: K.DOWN,
  A: K.A,
  B: K.B,
  Select: null,
  Start: K.START,
};

/** Keyboard → joypad, keyed by KeyboardEvent.code (layout/Shift independent). */
export const KEY_MAP = {
  ArrowUp: Button.Up,
  ArrowDown: Button.Down,
  ArrowLeft: Button.Left,
  ArrowRight: Button.Right,
  KeyZ: Button.A,
  KeyX: Button.B,
  Enter: Button.Start,
  Backspace: Button.Select,
  ShiftLeft: Button.Select,
  ShiftRight: Button.Select,
};

const NAME_TO_BTN = {
  up: Button.Up,
  down: Button.Down,
  left: Button.Left,
  right: Button.Right,
  a: Button.A,
  b: Button.B,
  start: Button.Start,
  select: Button.Select,
};

// ---- D-pad feel constants (all tunable; adjust on real devices per policy) ----
// Deadzone radius as a fraction of the pad's radius, interpolated by finger speed.
// Kept small so fast reversals barely pass through neutral (shooters), and it
// collapses at moderate speed; drift while held is handled by home calibration.
// Radius (fraction of the pad's radius) the thumb must reach before an ALREADY
// engaged direction is allowed to become a different one. Inside it the current
// direction is latched.
//
// Engaging and changing want opposite thresholds, and collapsing them into one
// velocity-adaptive deadzone got the change case backwards: it narrowed as the
// finger sped up, so it was at its thinnest exactly during a fast reversal — when
// the thumb sweeps past the origin and a few pixels of sideways slop swing the
// angle through whole sectors. That is where Left→Right flickering Down-Right came
// from. Engaging now has no radius requirement at all (a finger on the pad is
// always asking for a direction), and changing needs enough radius that the slop
// subtends less than a cardinal half-sector: ~10px of thumb bow over 0.28 radii
// works out to about 23°, inside the 24° band.
//
// It is a fraction of the thumb's OWN measured reach, not of the pad, because a
// fixed radius has to be smaller than the shortest reach it will ever meet or that
// player is locked into whichever direction they pressed first — they never travel
// far enough out to be allowed a different one. The touchdown estimator already
// tracks mean reach, so the threshold rides it and both ends get what they need:
// a long reach earns a wide, slop-proof commit radius, a short one still gets to
// change direction. Clamped at both ends so a degenerate estimate cannot disarm it.
const R_COMMIT_OF_REACH = 0.6;
const R_COMMIT_MIN = 0.12; // pad radii
const R_COMMIT_MAX = 0.3; // pad radii
const REACH_DEFAULT = 0.45; // assumed reach (pad radii) before any taps are in
// Radius the thumb must clear before ANY direction is engaged from neutral.
//
// This was removed once, on the reasoning that a contact is always intent and so
// should never land dead. The intent part holds; the conclusion did not. Measured
// over 270 real touchdowns, the ones landing near the origin were read correctly
// only 17-25% of the time (against 61.9% overall, and 12.5% for a coin toss) and
// roughly four in five of them came out as a DIAGONAL — manufacturing precisely
// the error that costs the most. Near the origin the angle is not a weak signal,
// it is no signal.
//
// It costs nothing to ignore them: not one of those touchdowns stayed inside the
// deadzone. Every one was already travelling outward, so the press is not lost,
// only held back the few ms until the thumb means something. Scaled to the user's
// own reach, like the commit radius.
const DZ_OF_REACH = 0.25;
const DZ_MIN = 0.08; // pad radii
const DZ_MAX = 0.2; // pad radii
const SPEED_STILL = 0.06; // px/ms below which home-calibration may run
// 押している間、指を原点の近く(パッド半径のこの割合)まで引き寄せる。
//
// これが無いと、右を押し続けた指は原点から 0.6r 離れたまま留まり、下へ切り替える
// には 70 度も動かす必要があって、途中で必ず斜めを経由する。「方向転換が重い」
// 「引っかかる」の正体はこれ(実測: どの方向でも 1.5 秒保持後の原点は (0,0) のまま、
// 指は 0.60r)。
//
// 一度これを削除したことがある。「指を触れたまま中央へ戻すと方向が残る」を理由に
// したが、ニュートラルは指を離して作るものでその場面は起きない、と後から分かった。
// 根拠が無くなった時点で戻すべきだった。デッドゾーンを跨ぐ心配は、接地のたびに
// 原点を推定値へ寄せる仕組み(foldTouchdown)が別途受け持っている。
//
// 引き込むのは「超過分」だけで、この半径より内側へは押し込まない。押しが
// デッドゾーンを割って消えることが無いよう、値はそれより十分外側に置く。
const R_TARGET = 0.28;
// 引き寄せの目標リーチの上限(パッド半径比)。学習値がこれを超えても、原点を
// これ以上外へは預けない。
const R_MAX_TARGET = 0.6;
// Angular sectors (degrees): only a slight cardinal bias so 8-way diagonals stay
// reliably reachable (shooters) while straight is still a touch easier (platformers).
// The four cardinals and the four diagonals split the circle between them, so one
// number fixes both: cardHalf + diagHalf == 45 always.
//
// The split is not constant, because the two ways of getting a direction wrong do
// not cost the same. A cardinal that comes out as a DIAGONAL is the expensive one:
// the wanted direction is in there, so the game does the asked-for thing AND
// something else, and the feedback is too ambiguous to learn from. A diagonal that
// comes out as a cardinal is cheap by comparison — plainly one thing, plainly
// short. On a real cross-pad the shape enforces that asymmetry; a flat screen has
// to supply it.
//
// So the FIRST read after a touchdown gives the cardinals 65% of the circle, and
// once a direction is engaged the split relaxes to an even 50/50 so eight-way
// aiming is fully available. Replayed over 261 recorded touchdowns, this trades
// cardinal-read-as-diagonal 31.9% -> 24.4% for diagonal-read-as-cardinal
// 33.3% -> 44.4%.
const CARD_HALF_ENGAGE = 29.25; // 65% of the circle to the cardinals
const CARD_HALF_HELD = 22.5; // an even 50/50 once engaged
const SHARE_RAMP_TICKS = 18; // ~300 ms of calibration ticks to relax across
// Four-way mode. cardHalf == 45 leaves the diagonals a width of zero, so each
// cardinal simply owns its quadrant and no diagonal can be produced at all — the
// same single number that biases the split also switches the mode off entirely.
//
// Plenty of Game Boy games only ever read four directions, and there a diagonal is
// not a nuance to be aimed for but pure noise: walking left in an overworld and
// picking up a stray Up is only ever an annoyance. With no diagonals to reach for,
// the pad can also afford to resist CHANGING direction much harder, so a thumb
// wandering during a long walk does not trip into a neighbour.
const CARD_HALF_4WAY = 45;
const R_COMMIT_4WAY = 1.6; // multiplies the commit radius (and its clamps)
const ANGLE_HYST = 6; // extra degrees to leave a sector — only while nearly still
// Home calibration (the pad following the thumb during neutral+still).
const HOME_LEAK = 1.2; // per-second rate the home folds toward the finger
// 較正は当初、横方向だけ弱くしていた。「左右には手の固定基準(端末の縁・A/B に
// 置いた反対の手)があるので補正は要らない」という理屈だったが、実測がこれを
// 否定している。実機の接地から原点を当てはめると横に +14.5px ずれており、縦と
// 同程度の補正を必要としていた。加えて、横だけ引き込みが効かないと、右や左を
// 押した指が原点から離れたまま留まり、方向転換に大きな移動が要る(実測: 左を
// 保持した後も 0.55r のまま。縦は 0.33r まで寄る)。根拠の無い非対称は外す。
const HOME_LEAK_X = 1; // 横も縦と同じ率で較正する
const HOME_MAX_X = 0.4; // max horizontal home offset, in pad radii
const HOME_MAX_Y = 0.55; // max vertical home offset, in pad radii
// On a direction change, keep this fraction of the home's drift (relax the rest
// toward centre) so the NEW direction reads from a fresh reference, not the old
// direction's specialised drift. Steady holds (no change) keep drifting.
const RELAX_ON_TURN = 0.6;
// Post-release return to centre. Nothing moves for HOME_RETURN_DELAY, so rapid
// tapping never sees the pad creep between taps; after that it eases with a long
// time-constant, slow enough to feel settled rather than sliding out from under
// the thumb. A pause still ends at a clean centre.
const HOME_RETURN_DELAY = 260; // ms of complete stillness before the return starts
const HOME_RETURN_TAU = 420; // ms time-constant of the ease once it does
// Touchdown rest estimator: a decaying least-squares fit for where the thumb
// rests, accumulated from touchdowns alone. See foldTouchdown.
const TD_DECAY = 0.92; // per touchdown — an effective window of ~12 recent taps
const TD_MIN_W = 2.5; // accumulated weight before the estimate is acted on
// Fraction of the estimated error absorbed per touchdown. Flat, deliberately: an
// error-proportional boost acquires an unfamiliar hand faster, but a single
// estimate off a short window is noisy enough to look badly wrong on its own, so
// boosting on that turns ordinary sampling noise into a lurching pad — and
// averaging the error first to tell bias from noise does not damp it enough to be
// worth the failure mode. A flat step scales noise and signal alike.
//
// The value is bounded from above by the same concern: taps scattered with no real
// rest point behind them still produce a wandering estimate, and a step big enough
// to chase it will flip a touchdown into the neighbouring sector. 0.3 tracks a
// genuine hand within a handful of taps and stays under that.
const TD_GAIN = 0.3;
// Per-touchdown pull back toward the pad's designed centre. Taps that sit
// symmetrically around wherever the home currently is confirm that spot and no
// other, so the estimate is only neutrally stable and sampling noise alone would
// random-walk the pad across the screen over a long session. This makes the centre
// the place the pad returns to without evidence, while staying far weaker than
// TD_GAIN so a real bias still parks it within a few percent of the truth.
const TD_LEAK = 0.03;
const EDGE_MARGIN = 8; // px the pad must stay inside the viewport
// 左端側は、当たり判定の余白だけなら画面外へ出てよい。パッドは画面左端から 12px
// の位置にあり、矩形ぜんぶを内側へ収めると原点は左へ 4px しか動けず、左を押した
// 指を追いかけられない(実測: 左を保持しても 0.55r のまま。縦は 0.33r まで寄る)。
//
// ただし出てよいのは**見えないもの**だけ。以前はパッド幅の 12% を一律で許して
// おり、矢印(内側 7% の位置)が 5% ほど物理画面の外へ出ていた。押せない絵が画面の
// 縁で欠けて見えるので、許容量は固定値をやめ、矢印の実測位置から決める
// (visibleInsetLeft)。矢印さえ内側にいれば、余白がいくら出ても見た目は変わらない。
const HAPTIC_MS = 8; // weak tick on each press edge (Android; no-op on iOS/desktop)

// A/B shared pad. Engagement is by distance to each button's centre, as a
// fraction of the centre separation. Above 0.5 so the midpoint falls inside both
// radii and the overlap engages BOTH — rolling one thumb from B to A never
// crosses a gap where neither is down.
const FACE_THR = 0.62;
// Second-finger latch. While exactly one other pointer is holding exactly one
// face button, a NEW touchdown resolves to the opposite button outright, with no
// regard for where it landed. Holding B to dash and tapping A to jump is the case
// this exists for.
//
// It reads as aggressive and is not: the premise is near-certain. A player
// already holding B has no reason to plant a second finger on B — the per-button
// refcount makes a second B a no-op. A touchdown arriving during a committed
// hold is asking for the OTHER button, and that inference is far stronger
// evidence than the distance to a centre. The earlier attempt widened the
// opposite button's radius instead, which was the same intent expressed through
// the weaker signal, and it had to be tuned (too strong, then too weak) precisely
// because distance was never what decided the answer.
//
// The latch does not survive travel. A tap does not move, so a finger that walks
// FACE_LATCH_TRAVEL from where it landed is doing something deliberate and is
// handed back to plain geometry. That is the tap/slide split, and it is why the
// latch can afford to ignore position at touchdown.
const FACE_LATCH_TRAVEL = 0.3; // fraction of the centre separation
// A button this pointer already holds is harder to leave than it was to enter,
// so a dash held through a wandering thumb does not drop at the same line it
// engaged on. Small: it widens the both-down band on a one-thumb roll.
const FACE_HYST = 1.12;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Eight directions on the pad, centre angle (screen degrees: 0=right, 90=down)
// and the button(s) each engages. Cardinal half-widths exceed diagonal ones so
// the "straight" bands dominate the circle.
const DIR8 = {
  R: { c: 0, btns: [Button.Right] },
  DR: { c: 45, btns: [Button.Down, Button.Right] },
  D: { c: 90, btns: [Button.Down] },
  DL: { c: 135, btns: [Button.Down, Button.Left] },
  L: { c: 180, btns: [Button.Left] },
  UL: { c: 225, btns: [Button.Up, Button.Left] },
  U: { c: 270, btns: [Button.Up] },
  UR: { c: 315, btns: [Button.Up, Button.Right] },
};
/** Half-width of one sector, given how much of the circle the cardinals hold. */
const halfOf = (name, cardHalf) =>
  DIR8[name].btns.length === 2 ? 45 - cardHalf : cardHalf;
const DIR8_ORDER = ["R", "DR", "D", "DL", "L", "UL", "U", "UR"];
// 方向ごとのボタン集合をあらかじめ作っておく。resolveDirs はポインタイベント
// ごとと較正ティックごとに呼ばれるので、そのたびに new Set していた。applyDpad は
// 読むだけで中身を変えないため、共有して問題ない。
const DIR8_SETS = {};
for (const k of DIR8_ORDER) DIR8_SETS[k] = new Set(DIR8[k].btns);
const NO_DIRS = new Set();

const norm360 = (deg) => ((deg % 360) + 360) % 360;
const angularDist = (a, b) => {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
};
/** Raw sector for an angle, ignoring hysteresis. Bands tile the circle exactly. */
const sectorRaw = (angle, cardHalf) => {
  for (const name of DIR8_ORDER) {
    const s = DIR8[name];
    if (angularDist(angle, s.c) <= halfOf(name, cardHalf)) return name;
  }
  return "R"; // unreachable (bands tile 360°), keeps the type total
};

/** Per-active-pointer D-pad tracking (position history, speed, current sector).
 *  lastX, lastY, lastT: last known pointer position/time.
 *  seenT: `lastT` as of the previous calibration tick — equal means no pointer event
 *    arrived in between, i.e. the finger is genuinely still and `speed` (which is
 *    only ever fed by move events) has to be decayed by the clock instead.
 *  speed: smoothed px/ms.
 *  dir8: current sector, for hysteresis; null at neutral.
 *  calibDir: `dir8` as of the previous calibration tick, for the direction-change relax.
 *  heldTicks: calibration ticks since this contact began; ramps the cardinal/diagonal
 *    split from its engage value to the even one.
 *  accDX, accDY: motion accumulated since the previous calibration tick (px), for the
 *    horizontal-slide rule — a tick can span several move events or none.
 *  dirs: currently engaged buttons. */

export class TouchGamepad {
  press;
  /** Optional per-gesture feedback hook (audio tick); fires once per batch on the
   *  same edge as the haptic, so a diagonal ticks once. */
  feedback;
  /** Live press count per button (all sources); edges drive setButton + visual. */
  counts = new Map();
  /** Element to flash for each button's pressed state. */
  visual = new Map();
  /** Perimeter direction-glow element per direction (edges, unoccluded by thumb). */
  edges = new Map();
  // Debug overlay (idea 7): visualise the otherwise-invisible geometry — deadzone,
  // sectors, current home offset — and log where touchdowns land, so the systematic
  // bias is visible. Read-only; the input model is untouched. Foundation for 41.
  overlay;
  octx = null;
  debug = false;
  /** Recent touchdowns in the pad's local px frame, coloured by resolved direction. */
  trace = [];
  /** State for each active D-pad pointer (position → direction, plus home calib). */
  dpadPtrs = new Map();
  /** A/B currently engaged by each active face pointer (proximity → set). */
  facePointers = new Map();
  /** Pointers latched to one button by the second-finger rule, with the point
   *  they landed on — the latch ends when the finger travels away from it. */
  faceLatch = new Map();
  /** Start/Select engaged by each active system pointer (proximity → set), so
   *  pressing between the two pills fires both — a real Start+Select. */
  sysPointers = new Map();
  dpad;
  /** Current home offset (px) from the pad's natural CSS centre, via transform. */
  ox = 0;
  oy = 0;
  /** rAF id for the post-release ease back to centre (0 = not running). */
  homingRaf = 0;
  homeTickLast = 0;
  /** rAF id for the while-held calibration clock (0 = not running). */
  calibRaf = 0;
  calibLast = 0;
  /** Decaying touchdown sums behind the rest estimate: total weight, position in
   *  the pad's NATURAL (untransformed) frame, reach, and unit direction. All decay
   *  at the same rate, which is what keeps them mutually consistent as the mix of
   *  tapped directions changes. See foldTouchdown. */
  tdW = 0;
  tdX = 0;
  tdY = 0;
  tdA = 0;
  tdUX = 0;
  tdUY = 0;
  /** 8 = diagonals available, 4 = cardinals only. Per-game; see CARD_HALF_4WAY. */
  ways = 8;
  /** Calibration gain per axis (multiples of HOME_LEAK); see setHomeGain. */
  gainX = HOME_LEAK_X;
  gainY = 1;
  /** Set true at the entry of each engaging gesture so a diagonal (two buttons)
   *  or any multi-button batch fires exactly one haptic tick, not one per button. */
  hapticArmed = false;
  /** iOS haptic fallback: a hidden <label><input type=checkbox switch>> whose
   *  toggle plays a Taptic tick (17.4+). Null where navigator.vibrate exists. */
  hapticLabel = null;
  face;
  aEl;
  bEl;
  sys;
  startEl;
  selectEl;

  constructor(root, press, feedback) {
    this.press = press;
    this.feedback = feedback;
    root.classList.add("bb-gamepad");
    root.innerHTML = `
      <div class="gp-dpad" aria-label="D-pad">
        <span class="gp-ext gp-ext-up"></span>
        <span class="gp-ext gp-ext-down"></span>
        <canvas class="gp-overlay" aria-hidden="true"></canvas>
        <span class="gp-arrow gp-up">▲</span>
        <span class="gp-arrow gp-down">▼</span>
        <span class="gp-arrow gp-left">◀</span>
        <span class="gp-arrow gp-right">▶</span>
        <span class="gp-hub"></span>
        <span class="gp-edge gp-edge-up"></span>
        <span class="gp-edge gp-edge-down"></span>
        <span class="gp-edge gp-edge-left"></span>
        <span class="gp-edge gp-edge-right"></span>
      </div>
      <div class="gp-system">
        <button class="gp-key gp-pill" data-btn="select" type="button">SELECT</button>
        <button class="gp-key gp-pill" data-btn="start" type="button">START</button>
      </div>
      <div class="gp-face">
        <button class="gp-key gp-round gp-b" data-btn="b" type="button"><span class="gp-ring" aria-hidden="true"></span>B</button>
        <button class="gp-key gp-round gp-a" data-btn="a" type="button"><span class="gp-ring" aria-hidden="true"></span>A</button>
      </div>`;

    const dpad = root.querySelector(".gp-dpad");
    this.dpad = dpad;
    this.overlay = root.querySelector(".gp-overlay") ?? undefined;
    this.visual.set(Button.Up, root.querySelector(".gp-up"));
    this.visual.set(Button.Down, root.querySelector(".gp-down"));
    this.visual.set(Button.Left, root.querySelector(".gp-left"));
    this.visual.set(Button.Right, root.querySelector(".gp-right"));
    // Direction glow at the pad's PERIMETER: the small centre arrows sit under the
    // thumb, but the edges (and their outward glow) stay clear of it, so pressed
    // direction is readable in peripheral vision without looking. A diagonal lights
    // two adjacent edges → an L at that corner.
    this.edges.set(Button.Up, root.querySelector(".gp-edge-up"));
    this.edges.set(Button.Down, root.querySelector(".gp-edge-down"));
    this.edges.set(Button.Left, root.querySelector(".gp-edge-left"));
    this.edges.set(Button.Right, root.querySelector(".gp-edge-right"));

    // Suppress the long-press context menu / callout on the whole pad.
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    // iOS still pops a text-selection magnifier ("loupe") on long-press even with
    // user-select:none; cancelling the native touch default on the pad kills it.
    // preventDefault cancels only the default gesture — the pointer events the
    // handlers below rely on still fire — so input is unaffected. Needs
    // passive:false, and touchmove covers the loupe that trails a hold-and-drag.
    root.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    root.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

    // Haptics: Android/Chrome use navigator.vibrate(); iOS has no such API, but
    // iOS 17.4+ plays a light Taptic tick whenever a <input type="checkbox" switch>
    // toggles. A hidden label wrapping one, clicked inside the touch gesture, is the
    // only way to buzz on iPhone (and only if System Haptics is enabled). Build it
    // just for the no-vibrate path so Android keeps using the real API.
    const nav = navigator;
    if (typeof nav.vibrate !== "function") {
      const label = document.createElement("label");
      label.setAttribute("aria-hidden", "true");
      // Rendered but invisible (display:none can stop the Taptic from firing).
      label.style.cssText =
        "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("switch", "");
      label.appendChild(input);
      root.appendChild(label);
      this.hapticLabel = label;
    }

    // D-pad: one region tracking each pointer's position → direction set.
    dpad.addEventListener("pointerdown", (e) => this.onDpadDown(e));
    dpad.addEventListener("pointermove", (e) => this.onDpadMove(e));
    dpad.addEventListener("pointerup", (e) => this.onDpadUp(e));
    dpad.addEventListener("pointercancel", (e) => this.onDpadUp(e));
    dpad.addEventListener("lostpointercapture", (e) => this.onDpadUp(e));

    // A learned home can fall off-screen if the viewport shrinks; re-clamp it.
    // レイアウトが動いたらキャッシュを捨てる。パッドは固定レイアウトで
    // スクロールしないが、向きの変更と設定由来の再配置だけは実際に動く。
    const relayoutSignal = () => {
      this.setHome(this.ox, this.oy);
    };
    window.addEventListener("resize", relayoutSignal);
    window.addEventListener("orientationchange", relayoutSignal);


    // Backstop: if an up/cancel never reaches the element that captured the
    // pointer, nothing would ever release its buttons. These run after the
    // element handlers (the events bubble), so for a normal release the id is
    // already gone and this is a no-op.
    const backstop = (e) => this.releasePointer(e.pointerId);
    window.addEventListener("pointerup", backstop);
    window.addEventListener("pointercancel", backstop);

    // A/B and Start/Select are both driven by shared pads (below); the buttons
    // themselves are visual only. Register each element's flash target here.
    for (const el of root.querySelectorAll(".gp-key[data-btn]")) {
      const btn = NAME_TO_BTN[el.dataset.btn ?? ""];
      if (btn !== undefined) this.visual.set(btn, el);
    }

    // A/B shared pad: one hit-area over both buttons; each pointer's position
    // resolves to A, B, or A+B (in the overlap between them), so sliding B→A
    // passes through B+A and ends on A alone.
    this.face = root.querySelector(".gp-face");
    this.aEl = root.querySelector(".gp-a");
    this.bEl = root.querySelector(".gp-b");
    this.face.addEventListener("pointerdown", (e) => this.onFaceDown(e));
    this.face.addEventListener("pointermove", (e) => this.onFaceMove(e));
    this.face.addEventListener("pointerup", (e) => this.onFaceUp(e));
    this.face.addEventListener("pointercancel", (e) => this.onFaceUp(e));
    this.face.addEventListener("lostpointercapture", (e) => this.onFaceUp(e));

    // Start/Select shared pad: one hit-area over both pills; pressing between them
    // resolves to BOTH, so the common Start+Select combo needs no two-finger aim.
    this.sys = root.querySelector(".gp-system");
    this.selectEl = root.querySelector('.gp-key[data-btn="select"]');
    this.startEl = root.querySelector('.gp-key[data-btn="start"]');
    this.sys.addEventListener("pointerdown", (e) => this.onSysDown(e));
    this.sys.addEventListener("pointermove", (e) => this.onSysMove(e));
    this.sys.addEventListener("pointerup", (e) => this.onSysUp(e));
    this.sys.addEventListener("pointercancel", (e) => this.onSysUp(e));
    this.sys.addEventListener("lostpointercapture", (e) => this.onSysUp(e));
  }

  /** Re-clamp the home after the pad's geometry changed from outside (e.g. the
   *  D-pad size setting). Layout changes don't fire a window resize. */
  relayout() {
    this.setHome(this.ox, this.oy);
    if (this.debug) this.sizeOverlay();
  }

  /** Record every D-pad gesture as a path, for fitting the input model to a REAL
   *  thumb instead of a guessed one.
   *
   *  Everything above this line was tuned against a synthetic thumb: land at
   *  rest + reach·û, add some scatter, done. That model cannot represent a thumb
   *  that travels in an ARC, whose bow differs per target direction, and which
   *  moves more freely one way along an axis than the other — all of which change
   *  which sector an instantaneous angle falls in, and none of which can be settled
   *  by inventing a second model and testing against it. So capture the real thing:
   *  full paths, timestamps, in the pad's natural frame, with what the pad decided,
   *  and fit afterwards. Off by default; pure observation, no effect on input. */
  recording = false;
  rec = [];

  setRecording(on) {
    this.recording = on;
  }

  get isRecording() {
    return this.recording;
  }

  /** Live finger state, for sampling alongside something else on the same clock
   *  (the calibration ROM's ground truth). Null when nothing is on the pad —
   *  which is itself the signal that the player is between gestures. */
  probe() {
    const st = this.dpadPtrs.values().next().value;
    if (!st) return null;
    const rect = this.dpad.getBoundingClientRect();
    const hx = st.lastX - (rect.left + rect.width / 2);
    const hy = st.lastY - (rect.top + rect.height / 2);
    return {
      x: Math.round((hx + this.ox) * 10) / 10,
      y: Math.round((hy + this.oy) * 10) / 10,
      hx: Math.round(hx * 10) / 10,
      hy: Math.round(hy * 10) / 10,
      ox: Math.round(this.ox * 10) / 10,
      oy: Math.round(this.oy * 10) / 10,
      dir: st.dir8 ?? "",
      reach: this.tdW >= TD_MIN_W ? Math.round((this.tdA / this.tdW) * 10) / 10 : 0,
    };
  }

  /** Samples pushed in from outside (the ROM's view of the same instant), carried
   *  along so the export is one correlated stream rather than two files to align. */
  frames = [];

  /** What the ROM is asking for right now. Stamped onto each gesture as it opens,
   *  so a recorded stroke carries its own label and nothing has to be aligned by
   *  timestamp afterwards. */
  tag = null;

  setTag(v) {
    this.tag = v;
  }

  pushFrameSample(s) {
    if (!this.recording) return;
    if (this.frames.length >= 200000) return;
    this.frames.push(s);
  }

  get recordedCount() {
    return this.rec.length;
  }

  get frameSampleCount() {
    return this.frames.length;
  }

  clearRecording() {
    this.rec.length = 0;
    this.frames.length = 0;
  }

  /** The captured gestures, plus the geometry needed to interpret them. */
  exportRecording() {
    const rect = this.dpad.getBoundingClientRect();
    return JSON.stringify({
      version: 1,
      padRadius: rect.width / 2,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      sectors: {
        cardHalf: CARD_HALF_ENGAGE,
        diagHalf: 45 - CARD_HALF_ENGAGE,
        cardHalfHeld: CARD_HALF_HELD,
      },
      ways: this.ways,
      gestures: this.rec,
      frames: this.frames,
    });
  }

  /** One sample. `x,y` are relative to the pad's NATURAL centre (so the learned
   *  home cannot smear the data); `hx,hy` are relative to the live home, which is
   *  what the pad actually judged; `d` is the sector it chose. */
  capture(st, id, fresh) {
    if (!this.recording) return;
    if (fresh && this.rec.length >= 400) this.rec.shift();
    const rect = this.dpad.getBoundingClientRect();
    const hx = st.lastX - (rect.left + rect.width / 2);
    const hy = st.lastY - (rect.top + rect.height / 2);
    const now = performance.now();
    if (fresh) this.rec.push({ id, t0: now, tag: this.tag, pts: [] });
    const g = this.rec[this.rec.length - 1];
    if (!g || (!fresh && g.id !== id)) return;
    if (g.pts.length > 600) return;
    g.pts.push({
      t: Math.round(now - g.t0),
      x: Math.round((hx + this.ox) * 10) / 10,
      y: Math.round((hy + this.oy) * 10) / 10,
      hx: Math.round(hx * 10) / 10,
      hy: Math.round(hy * 10) / 10,
      d: st.dir8 ?? "",
    });
  }

  /** Toggle the read-only debug overlay (deadzone / sectors / home / touchdowns). */
  setDebug(on) {
    this.debug = on;
    if (!this.overlay) return;
    this.overlay.style.display = on ? "block" : "none";
    if (on) {
      this.sizeOverlay();
      this.drawOverlay();
    }
  }

  sizeOverlay() {
    if (!this.overlay) return;
    const rect = this.dpad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(rect.width * dpr);
    this.overlay.height = Math.round(rect.height * dpr);
    this.octx = this.overlay.getContext("2d");
    this.octx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  traceColour(dirs) {
    if (dirs.size === 0) return "#7f8a9b"; // neutral — grey
    return dirs.size === 2 ? "#f0b429" : "#6ee7b7"; // diagonal amber / cardinal green
  }

  /** Redraw the overlay. `live` is the current fingertip in pad-local px, if any. */
  drawOverlay(live) {
    const ctx = this.octx;
    if (!ctx || !this.debug) return;
    const box = this.padBox();
    const w = box.w;
    const h = box.h;
    const cx = w / 2; // current home = element centre (the transform moved the frame)
    const cy = h / 2;
    const radius = w / 2;
    ctx.clearRect(0, 0, w, h);

    // Sector boundary spokes.
    ctx.strokeStyle = "rgba(127,138,155,0.35)";
    ctx.lineWidth = 1;
    for (const k of DIR8_ORDER) {
      const s = DIR8[k];
      const hw = halfOf(k, CARD_HALF_ENGAGE);
      for (const edge of [s.c - hw, s.c + hw]) {
        const a = (edge * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
        ctx.stroke();
      }
    }
    // Deadzone (still width) and the natural home marker (drift = distance to it).
    ctx.strokeStyle = "rgba(110,231,183,0.6)";
    ctx.beginPath();
    ctx.arc(cx, cy, this.commitRadius(radius), 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "rgba(127,138,155,0.5)";
    ctx.beginPath();
    ctx.arc(cx - this.ox, cy - this.oy, 3, 0, 2 * Math.PI); // natural centre
    ctx.fill();

    // Touchdown history, oldest faint.
    for (let i = 0; i < this.trace.length; i++) {
      const t = this.trace[i];
      ctx.globalAlpha = 0.12 + (0.55 * (i + 1)) / this.trace.length;
      ctx.fillStyle = t.c;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (live) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(live.x, live.y, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  localPt(e) {
    const box = this.padBox();
    const v = this.toElem(e.clientX - box.cx, e.clientY - box.cy);
    return { x: box.w / 2 + v.x, y: box.h / 2 + v.y };
  }

  /** Release everything a pointer id still holds, wherever it is tracked.
   *
   *  Two things make this necessary. A pointerup/cancel can simply never arrive
   *  (system gestures, interruptions), and browsers recycle pointer ids — so the
   *  next touch can reuse an id that is still holding buttons. Overwriting that
   *  entry orphaned its reference counts, leaving the direction pressed forever:
   *  the D-pad then looks dead because the emulator already sees it held. */
  releasePointer(id) {
    const st = this.dpadPtrs.get(id);
    if (st) {
      this.applyDpad(st, NO_DIRS);
      this.dpadPtrs.delete(id);
    }
    if (this.facePointers.has(id)) {
      this.applyFace(id, new Set());
      this.facePointers.delete(id);
      this.faceLatch.delete(id);
    }
    if (this.sysPointers.has(id)) {
      this.applySystem(id, new Set());
      this.sysPointers.delete(id);
    }
  }

  /** Show the SOFTWARE press behind A/B repeat. The finger stays down the whole
   *  time, so the ordinary pressed look says nothing about what the emulator is
   *  actually receiving; this ring blinks on the real edges, which is what makes
   *  the repeat rate something you can see rather than guess at. */
  setFireRing(btn, on) {
    this.visual.get(btn)?.querySelector(".gp-ring")?.classList.toggle("gp-firing", on);
  }

  /** Switch between eight-way and cardinals-only. */
  setWays(ways) {
    if (this.ways === ways) return;
    this.ways = ways;
    // Anything held under the old geometry may not be legal under the new one.
    for (const st of this.dpadPtrs.values()) this.readDirs(st);
  }

  get wayCount() {
    return this.ways;
  }

  /** Per-axis calibration gain, as a multiple of the base rate. Separate because
   *  left/right has two fixed anchors (the device edge under the palm, the other
   *  hand on A/B) and needs almost none, while up/down has no landmark at all. */
  setHomeGain(x, y) {
    this.gainX = x;
    this.gainY = y;
  }

  /** Route a keyboard press through the same counting path (for visual + IRQ). */
  handleKey(btn, down) {
    if (down) this.hapticArmed = true;
    this.setBtn(btn, down);
  }

  /** Force-release everything (pause, blur, ROM swap) so nothing sticks down,
   *  and return the pad to its natural home. */
  releaseAll() {
    for (const [btn, c] of this.counts) {
      if (c > 0) {
        this.press(btn, false);
        this.visual.get(btn)?.classList.remove("gp-active");
      }
    }
    this.counts.clear();
    this.dpadPtrs.clear();
    this.facePointers.clear();
    this.faceLatch.clear();
    this.sysPointers.clear();
    this.resetHome();
    // The rest estimate describes the user's HAND, which a pause or a ROM swap
    // does not change — keep it, so play resumes already calibrated. The next
    // touchdown eases the home straight back onto it.
  }

  // ---- reference-counted edge dispatch ----

  setBtn(btn, down) {
    const c = this.counts.get(btn) ?? 0;
    const nc = down ? c + 1 : Math.max(0, c - 1);
    this.counts.set(btn, nc);
    if (c === 0 && nc > 0) {
      this.press(btn, true);
      this.visual.get(btn)?.classList.add("gp-active");
      this.edges.get(btn)?.classList.add("gp-active");
      // One tick per gesture batch: a diagonal engages two buttons but buzzes once.
      if (this.hapticArmed) {
        this.hapticArmed = false;
        this.haptic();
        this.feedback?.(btn);
      }
    } else if (c > 0 && nc === 0) {
      this.press(btn, false);
      this.visual.get(btn)?.classList.remove("gp-active");
      this.edges.get(btn)?.classList.remove("gp-active");
    }
  }

  /** Weak tactile tick on a press edge. Android/Chrome vibrate(); iOS 17.4+ falls
   *  back to toggling the hidden switch (Taptic). No-op elsewhere (desktop, older
   *  iOS, or System Haptics disabled) — never relied upon for correctness. */
  haptic() {
    const nav = navigator;
    if (typeof nav.vibrate === "function") {
      try {
        nav.vibrate(HAPTIC_MS);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      this.hapticLabel?.click();
    } catch {
      /* ignore */
    }
  }

  // ---- D-pad ----

  /**
   * 画面の「触れない縁」の幅を測る。
   *
   * ダイナミックアイランドやノッチの下は、こちらのイベントが届かない。
   * viewport-fit=cover で描いているので innerWidth/innerHeight にはその領域も
   * 含まれており、素直に画面の内側へ収めるとパッドがそこへ入り込む。
   * 入り込んだ先の指は届かないので、**パッドが操作不能になる**(実機で報告)。
   *
   * 値は CSS の env(safe-area-inset-*) を、こちらへ渡してある変数から読む。
   * 端末を回すと変わるので、その都度読み直す(控えない)。
   */
  safeInsets() {
    const cs = getComputedStyle(document.documentElement);
    const px = (name) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? Math.max(0, v) : 0;
    };
    return {
      left: px("--bb-safe-left"),
      right: px("--bb-safe-right"),
      top: px("--bb-safe-top"),
      bottom: px("--bb-safe-bottom"),
    };
  }

  /** Move the pad's home to (ox,oy) px from its natural centre, double-clamped:
   *  it may not leave the SAFE area (EDGE_MARGIN + inset) nor wander past
   *  HOME_MAX radii. */
  setHome(ox, oy) {
    // 回した画面では、外接矩形も画面寸法も要素座標とは軸が違う。ox/oy は要素座標
    // (transform: translate)なので、突き合わせる矩形・縁・画面寸法もそちらへ揃える。
    const rect = this.elemRect();
    const natLeft = rect.left - this.ox;
    const natTop = rect.top - this.oy;
    const radius = rect.width / 2;
    const { w: vw, h: vh } = this.elemViewport();
    const capX = HOME_MAX_X * radius;
    const capY = HOME_MAX_Y * radius;

    // 触れない縁(ダイナミックアイランド・ノッチ)のぶんだけ内側へ寄せる。
    const safe = this.safeInsets();
    // 器が実際に空けている量(枠)を優先する。見えている帯は「縁」そのものでは
    // なく、縁に余裕を足して左右そろえた量なので、縁の生の値だけを見ると、島と
    // 反対側では 0 になり帯の中まで動けてしまう(実機で報告)。
    const frame = this.frameRect();
    const fl = frame ? frame.left : safe.left;
    const fr = frame ? vw - frame.right : safe.right;
    const ft = frame ? frame.top : safe.top;
    const fb = frame ? vh - frame.bottom : safe.bottom;
    // 左だけは、当たり判定の矩形ではなく**塗られている左端**を枠に合わせる。
    // EDGE_MARGIN を積まないのは、物理的な制約(画面外に出さない)と、見た目の
    // 余裕は別物だから。ここで 8px を積むと、パッドは左へ 1px も動けなくなる。
    const visLeft = natLeft + this.visibleLeftOffset();
    let minOx = Math.max(fl - visLeft, -capX);
    let maxOx = Math.min(vw - EDGE_MARGIN - fr - (natLeft + rect.width), capX);
    // There is deliberately no clamp against the A/B pad here any more. It was
    // meant to stop an overlapping D-pad from swallowing A/B, but .gp-face carries
    // z-index 3 while .gp-dpad is positioned with z-index auto, so the face already
    // wins the hit-test wherever they overlap — and on a phone-width layout the
    // pad's right edge sits within a few px of the face, so the clamp evaluated to
    // "may not move right AT ALL". Measured on hardware, this player's touches are
    // centred 14.5px to the RIGHT of the pad, and that correction was therefore
    // impossible to make: the pad could learn a vertical offset but never a
    // horizontal one, in the one direction that mattered.
    let minOy = Math.max(EDGE_MARGIN + ft - natTop, -capY);
    let maxOy = Math.min(vh - EDGE_MARGIN - fb - (natTop + rect.height), capY);
    // Degenerate viewport (pad wider than the room): keep at least one edge in.
    if (maxOx < minOx) maxOx = minOx;
    if (maxOy < minOy) maxOy = minOy;

    this.ox = clamp(ox, minOx, maxOx);
    this.oy = clamp(oy, minOy, maxOy);
    this.dpad.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
  }

  /** Snap the pad back to its natural CSS centre immediately (pause/blur/ROM swap). */
  resetHome() {
    this.stopHomeReturn();
    this.ox = 0;
    this.oy = 0;
    this.dpad.style.transform = "translate(0px, 0px)";
  }

  stopHomeReturn() {
    if (this.homingRaf) {
      cancelAnimationFrame(this.homingRaf);
      this.homingRaf = 0;
    }
  }

  /** After the last finger lifts, ease the home back to REST instead of snapping.
   *  A snap fights muscle memory: the thumb has just adapted to the drifted pad, so
   *  an instant jump makes the next input (especially a different direction) land
   *  wrong. Easing keeps a quick re-tap consistent with what was just used, while a
   *  pause settles on a clean, predictable reference. A new touch cancels it and
   *  keeps whatever position the return has reached.
   *
   *  The target is the estimated rest point, not the bare CSS centre: the centre is
   *  only the right answer before anything has been learned about the hand, and
   *  easing back to it after every pause would throw that away between each tap. */
  startHomeReturn() {
    if (this.homingRaf) return;
    this.homeTickLast = 0;
    let startT = 0;
    const rest = this.restEstimate() ?? { x: 0, y: 0 };
    const tick = (now) => {
      if (this.dpadPtrs.size > 0) {
        this.homingRaf = 0; // a finger arrived — leave the home where it is
        return;
      }
      if (startT === 0) startT = now;
      if (this.homeTickLast === 0) this.homeTickLast = now;
      const dt = Math.min(64, now - this.homeTickLast); // clamp after a stall
      this.homeTickLast = now;
      // Hold still first: during rapid tapping the gaps never reach this, so the
      // pad stays exactly where the thumb has been using it.
      if (now - startT < HOME_RETURN_DELAY) {
        this.homingRaf = requestAnimationFrame(tick);
        return;
      }
      const decay = Math.exp(-dt / HOME_RETURN_TAU); // frame-rate independent
      const nx = rest.x + (this.ox - rest.x) * decay;
      const ny = rest.y + (this.oy - rest.y) * decay;
      if (Math.abs(nx - rest.x) < 0.5 && Math.abs(ny - rest.y) < 0.5) {
        this.homingRaf = 0;
        this.setHome(rest.x, rest.y);
        return;
      }
      this.setHome(nx, ny);
      this.homingRaf = requestAnimationFrame(tick);
    };
    this.homingRaf = requestAnimationFrame(tick);
  }

  /** Resolve the engaged buttons for a pointer at distance r / vector (vx,vy)
   *  from the origin, applying the dynamic deadzone and cardinal-biased sectors
   *  with angular hysteresis. Mutates st.dir8. */
  /** 画面ぜんたいの回転(度)。0 / 90 / -90。app から伝えられる。 */
  rotation = 0;

  setRotation(deg) {
    this.rotation = deg === 90 || deg === -90 ? deg : 0;
    this.resetHome(); // 旧座標系で学んだ原点は、回した先では意味が違う
  }

  /** 画面座標のベクトルを、回した後の要素の座標系へ移す。
   *
   *  回転は見た目だけでなく座標系ごと回る。clientX/Y の差分(画面座標)をそのまま
   *  原点オフセット ox/oy(要素座標。transform: translate で効く)へ足すと、補正が
   *  指と**直角**の方向へ走り、収束しないまま上限まで動く。パッドが指の下から
   *  逃げていき、押しっぱなしの途中で指が離れた判定になる(実機で報告)。
   *
   *  指の位置・原点・触れない縁の判定を、すべてこの要素座標へ揃える。入口で 1 回
   *  だけ回せば、扇形も履歴も較正も回転を知らずに済む。 */
  toElem(dx, dy) {
    if (this.rotation === 90) return { x: dy, y: -dx };
    if (this.rotation === -90) return { x: -dy, y: dx };
    return { x: dx, y: dy };
  }

  /** パッド自身(回す前)の寸法と、画面座標での中心。回すと外接矩形は縦横が
   *  入れ替わるので、rect.width をそのまま半径に使ってはいけない。 */
  padBox() {
    const r = this.dpad.getBoundingClientRect();
    const swap = this.rotation !== 0;
    return {
      w: swap ? r.height : r.width,
      h: swap ? r.width : r.height,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
    };
  }

  /** パッドの矩形を要素座標で返す。縁(--bb-safe-*)は回転を織り込んで付け替えて
   *  あるので、突き合わせる相手もこの座標系でなければならない。 */
  elemRect(el = this.dpad) {
    const r = el.getBoundingClientRect();
    if (this.rotation === 90)
      return { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width };
    if (this.rotation === -90)
      return { left: window.innerHeight - r.bottom, top: r.left, width: r.height, height: r.width };
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  /** 塗られている部品のうち、いちばん左に出ているものの位置(要素座標 px、パッド
   *  の矩形の左辺からの相対)。内側なら正、外へ出ていれば負。
   *
   *  矢印だけを見てはいけない。縁のバー(.gp-edge-left)はパッドの箱より 4px 外に
   *  置かれており、矩形を基準にすると「見えないはず」の量が実際には見えている。
   *  逆に当たり判定の余白(.gp-ext)や debug 用のキャンバスは塗られないので数えない。 */
  visibleLeftOffset() {
    const base = this.elemRect().left;
    let min = 0; // パッド自身の地の色があるので、箱の左辺は常に見えている
    for (const el of this.dpad.querySelectorAll(
      ".gp-arrow, .gp-edge, .gp-hub",
    )) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      const r = this.elemRect(el);
      if (r.width <= 0 || r.height <= 0) continue;
      min = Math.min(min, r.left - base);
    }
    return min;
  }

  /** 置いてよい枠(器の content box)を要素座標で返す。 */
  frameRect() {
    const host = this.dpad.closest(".bb-root");
    if (!host) return null;
    const r = this.elemRect(host);
    const cs = getComputedStyle(host);
    const n = (v) => parseFloat(v) || 0;
    return {
      left: r.left + n(cs.paddingLeft),
      right: r.left + r.width - n(cs.paddingRight),
      top: r.top + n(cs.paddingTop),
      bottom: r.top + r.height - n(cs.paddingBottom),
    };
  }

  elemViewport() {
    return this.rotation === 0
      ? { w: window.innerWidth, h: window.innerHeight }
      : { w: window.innerHeight, h: window.innerWidth };
  }

  resolveDirs(
    st,
    vx,
    vy,
    r,
    rCommit,
    sticky,
    cardHalf,
    engageDz,
  ) {
    // vx/vy は要素座標で渡ってくる(toElem を通してある)。ここで回すと二重になる。
    // A finger ON the pad is always asking for a direction: neutral is achieved by
    // lifting, never by centring. So nothing here may return the empty set — a
    // direction already engaged is LATCHED until the thumb has travelled far enough
    // out to mean a different one, and a touchdown (nothing latched yet) falls
    // straight through to the angle, which is why a tap can no longer land dead.
    if (st.dir8 !== null && r < rCommit) return DIR8_SETS[st.dir8];
    // Nothing engaged yet and too close to the origin for the angle to mean
    // anything — wait rather than guess. See DZ_OF_REACH.
    if (st.dir8 === null && r < engageDz) return NO_DIRS;
    const angle = norm360((Math.atan2(vy, vx) * 180) / Math.PI);
    let dir = sectorRaw(angle, cardHalf);
    // Hysteresis holds the current sector until the angle clears its band + margin,
    // but ONLY while nearly still (anti-chatter). During an active sweep it is off
    // so fast reversals / diagonal changes track the raw angle immediately.
    if (sticky && st.dir8 !== null && st.dir8 !== dir) {
      const cur = DIR8[st.dir8];
      if (angularDist(angle, cur.c) <= halfOf(st.dir8, cardHalf) + ANGLE_HYST) dir = st.dir8;
    }
    st.dir8 = dir;
    return DIR8_SETS[dir];
  }

  applyDpad(st, next) {
    const prev = st.dirs;
    for (const b of prev) if (!next.has(b)) this.setBtn(b, false);
    for (const b of next) if (!prev.has(b)) this.setBtn(b, true);
    st.dirs = next;
  }

  // ---- thumb rest-point estimator (touchdowns) ----

  /** Fold one touchdown into the running fit for the thumb's rest point.
   *
   *  A tap that never moves is the only thing a tap-only player produces, so it has
   *  to be a learning signal or the pad never calibrates for them at all — which is
   *  precisely what "the correction doesn't run unless I slide" was.
   *
   *  One tap on its own is useless: P = rest + arm·û has more unknowns than
   *  equations, and no cleverness recovers `rest` from it. What a tap DOES pin down
   *  is the component of `rest` perpendicular to û — the arm length only ever moves
   *  the thumb along û, so it cannot explain any sideways offset. Fitting
   *  `rest` to minimise the perpendicular residual over recent taps is therefore
   *  the whole estimator, and it is linear:
   *
   *      minimise Σ ‖(I − û_iû_iᵀ)(P_i − rest)‖²   ⇒   M·rest = b
   *      M = Σ (I − û_iû_iᵀ)                       b = Σ (I − û_iû_iᵀ)P_i
   *
   *  The one assumption is that how FAR the thumb reaches does not depend on WHICH
   *  way it reaches — true of a thumb pivoting at its base. Then, over recent taps,
   *
   *      rest = mean(P) − mean(a)·mean(û)
   *
   *  and every term is measurable: P in the pad's natural frame, and a and û from
   *  the tap's offset from the current home. Aims spread around the circle drive
   *  mean(û) to zero and the estimate is just the centroid, which is the rest point
   *  exactly. Aims that all point one way make a·û equal the offset from the home
   *  for every tap, the subtraction cancels the centroid term completely, and the
   *  estimate degenerates to the home itself — the honest answer, since reach and
   *  origin are genuinely indistinguishable there. So a Left-only player keeps
   *  whatever the pad already knew instead of having it dragged leftward, which a
   *  plain centroid would do. In between it interpolates, and because all three
   *  sums decay together it stays consistent while the mix CHANGES too: a player
   *  who taps all over and then hammers one direction never sees the pad crawl.
   *
   *  Position is banked in the natural frame, which is what the estimate is FOR;
   *  a and û come from the current home, which is the running estimate of `rest`
   *  itself, and that is what makes home == rest an exact fixed point. */
  foldTouchdown(px, py, hx, hy) {
    const a = Math.hypot(hx, hy);
    // A tap essentially on the origin has no meaningful direction, and û = 0 with
    // a = 0 says exactly that: it contributes only to the centroid.
    const ux = a > 1 ? hx / a : 0;
    const uy = a > 1 ? hy / a : 0;
    this.tdW = this.tdW * TD_DECAY + 1;
    this.tdX = this.tdX * TD_DECAY + px;
    this.tdY = this.tdY * TD_DECAY + py;
    this.tdA = this.tdA * TD_DECAY + a;
    this.tdUX = this.tdUX * TD_DECAY + ux;
    this.tdUY = this.tdUY * TD_DECAY + uy;
  }

  /** Radius the thumb must clear before an engaged direction may become another,
   *  scaled to this thumb's measured reach. See R_COMMIT_OF_REACH. */
  /** Radius below which a fresh contact has no readable direction yet. */
  engageDeadzone(radius) {
    const reach =
      this.tdW >= TD_MIN_W ? this.tdA / this.tdW : radius * REACH_DEFAULT;
    const k = this.ways === 4 ? R_COMMIT_4WAY : 1;
    return clamp(reach * DZ_OF_REACH * k, radius * DZ_MIN * k, radius * DZ_MAX * k);
  }

  commitRadius(radius) {
    const reach =
      this.tdW >= TD_MIN_W ? this.tdA / this.tdW : radius * REACH_DEFAULT;
    const k = this.ways === 4 ? R_COMMIT_4WAY : 1;
    return clamp(
      reach * R_COMMIT_OF_REACH * k,
      radius * R_COMMIT_MIN * k,
      radius * R_COMMIT_MAX * k,
    );
  }

  /** The thumb's rest point as a home offset (px from the pad's natural centre),
   *  or null while too few taps have accumulated to mean anything. */
  restEstimate() {
    if (this.tdW < TD_MIN_W) return null;
    const a = this.tdA / this.tdW;
    return {
      x: this.tdX / this.tdW - (a * this.tdUX) / this.tdW,
      y: this.tdY / this.tdW - (a * this.tdUY) / this.tdW,
    };
  }

  /** Ease the home partway onto the fitted rest point, and a little back toward the
   *  pad's designed centre — see TD_LEAK for why the second half is not optional. */
  calibrateFromTaps() {
    const est = this.restEstimate();
    if (!est) return;
    this.setHome(
      this.ox + (est.x - this.ox) * TD_GAIN * this.gainX - this.ox * TD_LEAK,
      this.oy + (est.y - this.oy) * TD_GAIN * this.gainY - this.oy * TD_LEAK,
    );
  }

  onDpadDown(e) {
    e.preventDefault();
    this.hapticArmed = true;
    // This id may still be holding buttons from a touch whose up never arrived.
    this.releasePointer(e.pointerId);
    // D-pad は親指 1 本で使うものなので、常に「最後に触れた指」が所有する。
    //
    // 参照カウントは押している指の数を数えるので、前の指が離れる前に次の指が同じ
    // 方向へ触れると 1 -> 2 -> 1 と動いて 0 を通らない。つまり押し下げエッジも
    // 離しエッジも一度も発火せず、上位(routeButton)には何も届かない。速い連打は
    // 親指が完全には浮かないうちに次が触れるので、まさにこの形になり、ゲームからは
    // 押しっぱなしに見える(実測: 転がり連打 8 回で押し下げの立ち上がり 0 回)。
    //
    // 古い指を先に解放すればカウントは 0 を通り、エッジが正しく出る。手のひらが
    // 先に触れていた場合も、後から来た親指が正しく勝つ。
    for (const id of [...this.dpadPtrs.keys()]) {
      if (id !== e.pointerId) this.releasePointer(id);
    }
    // A fresh touch keeps whatever home the release-return has eased to so far.
    this.stopHomeReturn();

    // setPointerCapture can throw (InvalidPointerId) on odd/synthetic pointers;
    // capture is an optimization, not correctness, so never let it break input.
    try {
      this.dpad.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const box = this.padBox();
    const radius = box.w / 2;
    const { x: vx, y: vy } = this.toElem(e.clientX - box.cx, e.clientY - box.cy);
    const st = {
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: e.timeStamp,
      seenT: e.timeStamp,
      speed: 0,
      dir8: null,
      calibDir: null,
      heldTicks: 0,
      accDX: 0,
      accDY: 0,
      dirs: NO_DIRS,
    };
    // Touchdown is read absolutely from the current home, with no radius floor.
    this.resolveDirs(
      st,
      vx,
      vy,
      Math.hypot(vx, vy),
      this.commitRadius(radius),
      true,
      this.ways === 4 ? CARD_HALF_4WAY : CARD_HALF_ENGAGE,
      this.engageDeadzone(radius),
    );

    // Learn from the touchdown, then re-read it from the corrected home — so the
    // very tap that carries the information is also the first to benefit from it,
    // which is what a player who only ever taps needs in order to calibrate at all.
    // Skipped while another finger already owns the pad: moving the home out from
    // under a held finger would silently change that finger's direction.
    this.dpadPtrs.set(e.pointerId, st);
    if (this.dpadPtrs.size === 1) {
      this.foldTouchdown(vx + this.ox, vy + this.oy, vx, vy);
      this.calibrateFromTaps();
      // Clear the provisional read so the re-read is absolute: leaving it set would
      // let angular hysteresis defend the pre-correction answer, which is precisely
      // the answer the correction just decided was wrong.
      st.dir8 = null;
    }
    this.readDirs(st);
    this.capture(st, e.pointerId, true);
    const dirs = st.dirs;
    st.calibDir = st.dir8;
    this.startCalib();

    if (this.debug) {
      const p = this.localPt(e);
      this.trace.push({ x: p.x, y: p.y, c: this.traceColour(dirs) });
      if (this.trace.length > 40) this.trace.shift();
      this.drawOverlay(p);
    }
  }

  /** Pointer events only update kinematics and re-read the direction — the fast,
   *  latency-critical half. Calibration is deliberately NOT done here: a finger
   *  that holds still emits no move events at all, so anything hung off this
   *  handler simply stops correcting the moment the user stops sliding. */
  onDpadMove(e) {
    const st = this.dpadPtrs.get(e.pointerId);
    if (!st) return;
    e.preventDefault();
    this.hapticArmed = true;

    const dt = Math.max(1, e.timeStamp - st.lastT);
    const dxStep = e.clientX - st.lastX;
    const dyStep = e.clientY - st.lastY;
    const step = Math.hypot(dxStep, dyStep);
    st.speed = lerp(st.speed, step / dt, 0.6); // EMA of px/ms (fairly responsive)
    st.lastX = e.clientX;
    st.lastY = e.clientY;
    st.lastT = e.timeStamp;
    st.accDX += dxStep;
    st.accDY += dyStep;

    this.readDirs(st);
    this.capture(st, e.pointerId, false);
    if (this.debug) {
      this.drawOverlay(this.localPt(e));
    }
  }

  /** Re-resolve and apply the direction for a pointer from its last known point.
   *  Called on every move AND on every calibration tick, because the home moving
   *  under a motionless finger changes the answer just as much as the finger does. */
  readDirs(st) {
    const box = this.padBox();
    const radius = box.w / 2;
    const { x: vx, y: vy } = this.toElem(st.lastX - box.cx, st.lastY - box.cy);
    const r = Math.hypot(vx, vy);
    // Hysteresis only while nearly still; an active sweep tracks the raw angle.
    const sticky = st.speed < SPEED_STILL * 2;
    // Cardinal-heavy on the first read, easing to an even split as the press is
    // held — see CARD_HALF_ENGAGE for why the two errors are not worth the same.
    const cardHalf =
      this.ways === 4
        ? CARD_HALF_4WAY
        : lerp(
            CARD_HALF_ENGAGE,
            CARD_HALF_HELD,
            clamp(st.heldTicks / SHARE_RAMP_TICKS, 0, 1),
          );
    this.applyDpad(
      st,
      this.resolveDirs(
        st,
        vx,
        vy,
        r,
        this.commitRadius(radius),
        sticky,
        cardHalf,
        this.engageDeadzone(radius),
      ),
    );
  }

  /** The calibration clock. Runs while a finger is on the pad and is the ONLY
   *  driver of home calibration, so a dead-still hold corrects at exactly the same
   *  rate as a jittering one — and `speed`, which move events alone would leave
   *  frozen at whatever the last flick set it to, decays honestly.
   *
   *  Only a solo contact calibrates: with two fingers down there is no single
   *  thumb position to follow, and moving the home would change the other finger's
   *  direction under it. */
  startCalib() {
    if (this.calibRaf) return;
    this.calibLast = 0;
    const tick = (now) => {
      if (this.dpadPtrs.size === 0) {
        this.calibRaf = 0;
        return;
      }
      if (this.calibLast === 0) this.calibLast = now;
      const dt = Math.min(64, now - this.calibLast); // clamp after a stall
      this.calibLast = now;
      if (dt >= 1 && this.dpadPtrs.size === 1) {
        const st = this.dpadPtrs.values().next().value;
        if (st.lastT === st.seenT) {
          // No pointer event since the last tick: the finger is genuinely still.
          st.speed = lerp(st.speed, 0, 0.35);
          st.accDX = 0;
          st.accDY = 0;
        }
        st.seenT = st.lastT;
        st.heldTicks++;
        this.readDirs(st);
        // Sample the trace here too, not only on pointermove. A thumb that presses
        // and holds still emits no move events at all — which is the whole point of
        // the clock existing — so a recording driven by events alone captures a
        // single point for exactly the gestures the measurement is about.
        this.capture(st, this.dpadPtrs.keys().next().value, false);
        this.calibrate(st, dt);
        st.accDX = 0;
        st.accDY = 0;
      }
      this.calibRaf = requestAnimationFrame(tick);
    };
    this.calibRaf = requestAnimationFrame(tick);
  }

  padRadiusForCalib() {
    return this.padBox().w / 2;
  }

  /** One calibration step of `dt` ms, easing the pad's home toward the thumb. */
  calibrate(st, dt) {
    const box = this.padBox();
    const { x: vx, y: vy } = this.toElem(st.lastX - box.cx, st.lastY - box.cy);
    const k = clamp((HOME_LEAK * dt) / 1000, 0, 0.5);

    if (st.calibDir !== null && st.dir8 !== st.calibDir) {
      // The direction just changed. The home
      // is currently specialised to the OLD direction, which is exactly what makes
      // diagonal→cardinal tap-adjusts and cardinal→diagonal switches misread, so
      // relax it partway toward the thumb's ESTIMATED REST POINT — the best
      // reference available — and let the new direction re-calibrate from there.
      // Relaxing toward the bare CSS centre instead would throw away everything the
      // touchdowns have learned. A steady hold never hits this.
      const rest = this.restEstimate() ?? { x: 0, y: 0 };
      this.setHome(
        lerp(rest.x, this.ox, RELAX_ON_TURN),
        lerp(rest.y, this.oy, RELAX_ON_TURN),
      );
      // There is deliberately no neutral branch. It used to ease the home onto a
      // finger that was touching the pad without calling a direction, which is a
      // state that does not occur: a thumb that wants nothing is lifted, not
      // parked. Touchdowns are where the resting point is learned instead.
    } else if (st.dir8 !== null && st.speed < SPEED_STILL * 2) {
      // Any held direction — cardinal and diagonal under ONE law, because two laws
      // is what made "it corrects for left/right but not for up or diagonals". The
      // finger vector is split about the pressed direction and only the
      // PERPENDICULAR part is cancelled, so the press converges onto a clean axis
      // (or a clean 45° line) and can never rotate toward a neighbouring sector.
      //
      // Nothing is pulled ALONG the press axis. An along-pull walks the origin out
      // from under the thumb for as long as a direction is held, and then the two
      // things the user notices are that returning to rest still reads as that
      // direction, and that the next tap lands inside the moved deadzone and does
      // nothing at all. Keeping the origin fixed along the axis costs only the
      // pivot-shortening; the touchdown estimator keeps it near the thumb anyway.
      const cRad = (DIR8[st.dir8].c * Math.PI) / 180;
      const dxu = Math.cos(cRad);
      const dyu = Math.sin(cRad);
      const dot = vx * dxu + vy * dyu;
      const perpX = vx - dot * dxu;
      const perpY = vy - dot * dyu;
      // 押している軸に沿って、原点を指の側へ寄せる(= 指が原点に近づく)。超過分
      // だけなので、指が R_TARGET より内側にいるときは何もしない。これが方向転換
      // の移動量を決める。
      // 目標は固定値ではなく、**その指が実際に押している距離**。固定 R_TARGET
      // だと、自然な押し方(実測 REACH_DEFAULT 前後)でも毎回引き寄せが走り、
      // 押しっぱなしのあいだパッドが指の方向へ動き続けて指から外れる。学習した
      // リーチを目標にすれば、その人の癖より深く踏み込んだぶんだけを戻す。
      const radiusNow = this.padRadiusForCalib();
      const learned =
        this.tdW >= TD_MIN_W ? this.tdA / this.tdW : radiusNow * REACH_DEFAULT;
      const target = clamp(learned, radiusNow * R_TARGET, radiusNow * R_MAX_TARGET);
      const excess = Math.max(0, dot - target);
      // The per-axis gains still apply: left/right has physical anchors (the device
      // edge under the palm, the other hand on A/B) and needs little correction,
      // up/down has none. That asymmetry is about the axis, not about the sector,
      // so it is the same expression for all eight directions.
      this.setHome(
        this.ox + (perpX + excess * dxu) * k * this.gainX,
        this.oy + (perpY + excess * dyu) * k * this.gainY,
      );
    }
    st.calibDir = st.dir8;

    // Horizontal play must stay horizontal even mid-slide. The gated calibration
    // above pauses during a fast sweep — exactly when the thumb's incidental
    // height (held a little high/low) leaks in as up/down while sliding Left<->Right.
    // So whenever the motion is clearly horizontal and nothing vertical is intended
    // (Left/Right or neutral, no up/down), ease the VERTICAL home toward the thumb
    // at any speed, zeroing that height. Vertical has no anchor, so this is safe;
    // an intended up/down or a diagonal slide has real vertical motion and is
    // excluded, and the horizontal home is never touched here.
    const dirs = st.dirs;
    const noVertical =
      !dirs.has(Button.Up) &&
      !dirs.has(Button.Down) &&
      (dirs.size === 0 || dirs.has(Button.Left) || dirs.has(Button.Right));
    const acc = this.toElem(st.accDX, st.accDY);
    if (noVertical && Math.abs(acc.x) > Math.abs(acc.y) * 1.4 + 0.5) {
      const kv = clamp((HOME_LEAK * this.gainY * dt) / 1000, 0, 0.5);
      this.setHome(this.ox, this.oy + vy * kv);
    }
  }

  onDpadUp(e) {
    const st = this.dpadPtrs.get(e.pointerId);
    if (!st) return;
    this.applyDpad(st, NO_DIRS);
    this.dpadPtrs.delete(e.pointerId);
    // Last finger up → ease (don't snap) the pad back to its natural home.
    if (this.dpadPtrs.size === 0) this.startHomeReturn();
    if (this.debug) this.drawOverlay();
  }

  // ---- face / system buttons ----

  /** Select and/or Start by proximity to each pill; the region between them (up to
   *  0.66x the centre separation) engages BOTH, so a centre press = Start+Select. */
  systemButtonsAt(x, y) {
    const s = this.selectEl.getBoundingClientRect();
    const t = this.startEl.getBoundingClientRect();
    const sx = s.left + s.width / 2;
    const sy = s.top + s.height / 2;
    const tx = t.left + t.width / 2;
    const ty = t.top + t.height / 2;
    const dSel = Math.hypot(x - sx, y - sy);
    const dSta = Math.hypot(x - tx, y - ty);
    const thr = Math.hypot(sx - tx, sy - ty) * 0.66;
    const set = new Set();
    if (dSel < thr) set.add(Button.Select);
    if (dSta < thr) set.add(Button.Start);
    if (set.size === 0) set.add(dSel < dSta ? Button.Select : Button.Start);
    return set;
  }

  applySystem(id, next) {
    const prev = this.sysPointers.get(id) ?? new Set();
    for (const b of prev) if (!next.has(b)) this.setBtn(b, false);
    for (const b of next) if (!prev.has(b)) this.setBtn(b, true);
    this.sysPointers.set(id, next);
  }

  onSysDown(e) {
    e.preventDefault();
    this.hapticArmed = true;
    this.releasePointer(e.pointerId);
    try {
      this.sys.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.applySystem(e.pointerId, this.systemButtonsAt(e.clientX, e.clientY));
  }

  onSysMove(e) {
    if (!this.sysPointers.has(e.pointerId)) return;
    e.preventDefault();
    this.hapticArmed = true;
    this.applySystem(e.pointerId, this.systemButtonsAt(e.clientX, e.clientY));
  }

  onSysUp(e) {
    if (!this.sysPointers.has(e.pointerId)) return;
    this.applySystem(e.pointerId, new Set());
    this.sysPointers.delete(e.pointerId);
  }

  // ---- A/B shared pad ----

  /** Centres of A and B, and the distance between them. */
  faceGeometry() {
    const a = this.aEl.getBoundingClientRect();
    const b = this.bEl.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return { ax, ay, bx, by, sep: Math.hypot(ax - bx, ay - by) };
  }

  /** The single face button held ALONE by exactly one pointer other than `id`,
   *  or null. A pointer sitting in the overlap holds both and does not count:
   *  it is not committed, and treating it as committed makes the latch feed back
   *  on itself (a tap in the overlap would authorise the holding finger to latch
   *  onto the tapped button and keep it after the tap lifts). */
  faceSoloHeldByOther(id) {
    let found = null;
    for (const [pid, btns] of this.facePointers) {
      if (pid === id || btns.size !== 1) continue;
      if (found !== null) return null; // more than one committed hold: no inference
      for (const b of btns) found = b;
    }
    return found;
  }

  /** Buttons engaged for pointer `id` at (x,y).
   *
   *  Two readings of the same finger, in priority order:
   *
   *  1. LATCHED TAP — this pointer landed while another finger held one button,
   *     so it means the other one and position is not consulted. Ends when the
   *     finger travels FACE_LATCH_TRAVEL from where it landed (see below).
   *  2. GEOMETRY — A and/or B by proximity to each button's centre. The overlap
   *     between them engages BOTH, so a one-thumb roll never crosses a gap;
   *     sliding fully onto one releases the other. A button this pointer already
   *     holds resists leaving by FACE_HYST.
   *
   *  The buttons themselves never move under any reading — on a flat screen
   *  their positions are the only landmark the thumb has. */
  faceButtonsAt(x, y, id) {
    const { ax, ay, bx, by, sep } = this.faceGeometry();

    // 1. Latched tap. Breaking on travel is what lets the latch ignore position
    // at touchdown: a tap does not move, so a finger that walks off is asking
    // for something else and is handed back to geometry for the rest of its life.
    const latch = this.faceLatch.get(id);
    if (latch) {
      if (Math.hypot(x - latch.x, y - latch.y) < sep * FACE_LATCH_TRAVEL) {
        return new Set([latch.btn]);
      }
      this.faceLatch.delete(id);
    }

    // 2. Geometry.
    const dA = Math.hypot(x - ax, y - ay);
    const dB = Math.hypot(x - bx, y - by);
    const thr = sep * FACE_THR;
    const mine = this.facePointers.get(id);
    const hyst = (own) => (mine?.has(own) ? FACE_HYST : 1);

    const set = new Set();
    if (dA < thr * hyst(Button.A)) set.add(Button.A);
    if (dB < thr * hyst(Button.B)) set.add(Button.B);
    if (set.size === 0) set.add(dA < dB ? Button.A : Button.B); // nearest fallback
    return set;
  }

  applyFace(id, next) {
    const prev = this.facePointers.get(id) ?? new Set();
    for (const b of prev) if (!next.has(b)) this.setBtn(b, false);
    for (const b of next) if (!prev.has(b)) this.setBtn(b, true);
    this.facePointers.set(id, next);
  }

  onFaceDown(e) {
    e.preventDefault();
    this.hapticArmed = true;
    try {
      this.face.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Second finger arriving during a committed hold: it means the other button.
    const held = this.faceSoloHeldByOther(e.pointerId);
    if (held !== null) {
      const other = held === Button.A ? Button.B : Button.A;
      this.faceLatch.set(e.pointerId, { btn: other, x: e.clientX, y: e.clientY });
    }
    this.applyFace(e.pointerId, this.faceButtonsAt(e.clientX, e.clientY, e.pointerId));
  }

  onFaceMove(e) {
    if (!this.facePointers.has(e.pointerId)) return;
    e.preventDefault();
    this.hapticArmed = true;
    this.applyFace(e.pointerId, this.faceButtonsAt(e.clientX, e.clientY, e.pointerId));
  }

  onFaceUp(e) {
    if (!this.facePointers.has(e.pointerId)) return;
    this.applyFace(e.pointerId, new Set());
    this.facePointers.delete(e.pointerId);
    this.faceLatch.delete(e.pointerId);
  }
}

// ---- input.js 接続 ----
// この節から下は input.ts に対応物が無い、本プロジェクト固有の接着コード。
// TouchGamepad は空の div を渡せば内部で DOM を構築する設計なので、ここでは
// コンテナ要素を渡して press コールバックを input.js の pressButton/releaseButton
// へ繋ぐだけでよい。タッチ判定は前回同様 input.js の isTouch() に一本化し、
// body.touch を付与する(pointer: coarse 単独判定には戻さない — ハイブリッド
// 端末で操作不能になるため)。
let controlsSetUp = false;

/** TouchGamepad → input.js の橋渡し。Button.Select は本プロジェクトに対応する
 *  K ビットが無い(null)ため、そのまま無視する。 */
function routePress(btn, down) {
  if (btn == null) return;
  if (down) pressButton(btn);
  else releaseButton(btn);
}

function setUpControls() {
  if (controlsSetUp) {
    return null; // 二重初期化ガード(通常経路とpointerdown救済経路が両方走っても一度だけ)
  }
  const root = document.getElementById('touch-controls');
  if (!root) {
    return null;
  }
  controlsSetUp = true;
  document.body.classList.add('touch');
  return new TouchGamepad(root, routePress);
}

// 保険経路: pointer:coarseがfalseな端末(トラックパッド接続iPad等)でも、最初に
// pointerType==='touch'のpointerdownが来た時点でtouch扱いに切り替えて初期化する。
function onRescuePointerDown(e) {
  if (e.pointerType !== 'touch') {
    return;
  }
  window.removeEventListener('pointerdown', onRescuePointerDown, true);
  markTouchDetected();
  setUpControls();
}

export function initTouchControls() {
  if (isTouch()) {
    return setUpControls();
  }
  window.addEventListener('pointerdown', onRescuePointerDown, true);
  return null;
}

initTouchControls();
