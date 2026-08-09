// debug.js — URLクエリで「途中のウェーブから開始する」ための入口。
//
// なぜ要るか: 自動プレイのプローブはフレーム2000あたりでゲームオーバーになるため、
// ステージ後半のウェーブ(ガンワゴンやホイールソーなど)に一度も到達できず、実測での
// 確認ができなかった。開始位置と無敵を指定できれば、どの敵でも同じ手順で測れる。
//
// 出荷物に入れない作りにしてある。
//   - このファイルを import するのは src/main.js(ブラウザ単体版のエントリ)だけ。
//     ソフトカート経路(src/softcart.js)からは辿れないので、brickboy の同梱ビルド
//     (dist-bagulas/)には含まれない。
//   - クエリが無ければ何もしないので、単体Web版の通常の起動も変わらない。
//   - fb経路(Node のプローブ)は URL を持たないので、game.js の startPlayAt() を直接呼ぶ。
//     URLの解釈だけがこのファイルの仕事で、開始位置を進める処理自体はゲーム側の通常APIにある。
//
// 使い方:
//   ?wave=3            … 本編(main)の3番目のウェーブから開始
//   ?section=0&wave=2  … 前哨戦(prelude)の2番目から開始
//   ?wave=6&invuln=1   … 加えて無敵で開始(既定は無敵にしない)
import { startPlayAt } from './game.js';

const DEFAULT_SECTION = 1; // section 未指定なら本編(main)
const INVULN_FRAMES = 0x7fffffff; // 実質無期限。playerInvuln>0 の間は自機の判定がスキップされる

export function applyDebugStart(search) {
  const q = new URLSearchParams(search);
  const waveRaw = q.get('wave');
  if (waveRaw === null) {
    return false; // 通常起動。何もしない
  }
  const wave = parseInt(waveRaw, 10);
  if (Number.isNaN(wave)) {
    return false;
  }
  const sectionRaw = q.get('section');
  const sectionParsed = sectionRaw === null ? DEFAULT_SECTION : parseInt(sectionRaw, 10);
  const section = Number.isNaN(sectionParsed) ? DEFAULT_SECTION : sectionParsed;
  const invuln = q.get('invuln') !== null ? INVULN_FRAMES : 0;
  startPlayAt(section, wave, invuln);
  return true;
}
