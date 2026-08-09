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
//   ?only=drifter      … ドリフターのウェーブだけを空き時間をはさんで繰り返す(観察用)。
//                        自機は無敵で開始する(観察を止めないため)。invuln指定と併用してよい
//   ?wave=5&stage=1    … 段階3グループ2検証用。STAGES[1](ジャングル)のウェーブから開始
//                        (game.jsのstartPlayAt第4引数をそのまま横流しするだけで、
//                        stage省略時は0=荒野のまま。ここに新しいゲームロジックは足さない)
import { startPlayAt } from './game.js';
import { setWaveOverride } from './enemies.js';
import { FORMATIONS } from './stages.js';

const DEFAULT_SECTION = 1; // section 未指定なら本編(main)
const DEFAULT_STAGE = 0; // stage 未指定なら荒野(既存の挙動を変えない)
const INVULN_FRAMES = 0x7fffffff; // 実質無期限。playerInvuln>0 の間は自機の判定がスキップされる

// ?only= に渡せる種名 → stages.js の FORMATIONS 名。ここに無い名前は無視する。
const ONLY_FORMATIONS = {
  drifter: 'DRIFTER',
};

export function applyDebugStart(search) {
  const q = new URLSearchParams(search);
  const onlyRaw = q.get('only');
  if (onlyRaw !== null) {
    const name = ONLY_FORMATIONS[onlyRaw.toLowerCase()];
    if (name !== undefined && FORMATIONS[name] !== undefined) {
      // 観察を止めないため無敵で開始する。ウェーブは上書きされ、同じ種が繰り返し出る。
      startPlayAt(1, 0, INVULN_FRAMES);
      setWaveOverride(FORMATIONS[name]);
      return true;
    }
    console.error(`debug: ?only=${onlyRaw} は未対応。使えるのは: ${Object.keys(ONLY_FORMATIONS).join(', ')}`);
  }
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
  const stageRaw = q.get('stage');
  const stageParsed = stageRaw === null ? DEFAULT_STAGE : parseInt(stageRaw, 10);
  const stage = Number.isNaN(stageParsed) ? DEFAULT_STAGE : stageParsed;
  const invuln = q.get('invuln') !== null ? INVULN_FRAMES : 0;
  startPlayAt(section, wave, invuln, stage);
  return true;
}
