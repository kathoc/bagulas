// 敵一覧のHTMLを生成する。art/generated/*.js のドット絵データを埋め込み、
// 閲覧側の canvas で拡大描画する(画像エンコード不要・単一ファイルで完結)。
//
//   node tools/build_enemy_sheet.mjs > public-doc/enemies.html
//
// 元データは docs/enemies.md の設計。ここの表と食い違ったら docs 側を正とする。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// docs/enemies.md の一覧表と対応させる。slug は art/generated/enemy_<slug>.js
const ENEMIES = [
  { n: 1, slug: 'scatter', name: 'スキャッター', en: 'SCATTER', hp: '1', gate: '前左/前右/正面', num: 5,
    look: '車輪だけの単車。回転する円盤に見える',
    move: 'V字編隊で降り、中央から左右へ広がる', atk: 'なし(体当たり)', tel: '—',
    exit: '横流れ', role: '教育用。撃てば消える/当たれば死ぬ、を最初に教える', stage: 1 },
  { n: 2, slug: 'drifter', name: 'ドリフター', en: 'DRIFTER', hp: '2', gate: '前左/前右/正面', num: 4,
    look: '低く構えたバギー。後輪が大きい',
    move: '縦列で降り、画面中程から左右へ大きく蛇行', atk: '折り返し点で狙い1発', tel: '折り返しで減速',
    exit: '八の字', role: '「横に大きく動く」の主役。横切る敵に当てる練習', stage: 1 },
  { n: 3, slug: 'reaper', name: 'リーパー', en: 'REAPER', hp: '1', gate: '前左/前右', num: 5,
    look: '同じ車体が5台。1台だけ旗を立てている',
    move: '斜めに流れて画面外へ抜ける。滞在が短い', atk: 'なし', tel: '—',
    exit: '弧離脱(サイドへ)', role: '抜けきる前に5台倒すと高得点。速射の腕試し', stage: 1 },
  { n: 4, slug: 'hopper', name: 'ホッパー', en: 'HOPPER', hp: '3', gate: '前左/前右/正面', num: 3,
    look: '脚の生えた四輪。関節がむき出し',
    move: '跳ねながら降下。着地の瞬間だけ停止', atk: '着地の硬直中に真下へ1発', tel: '着地の停止そのもの',
    exit: '反転上昇', role: '硬直=撃ち込みどころ。リズムで倒す', stage: 2 },
  { n: 5, slug: 'gunwagon', name: 'ガンワゴン', en: 'GUN WAGON', hp: '4', gate: '正面のみ', num: 3,
    look: '砲を積んだ装甲車。砲身が長い',
    move: '画面上部に居座り、左右へ滑る。降りてこない', atk: '16方向の狙い撃ち', tel: '砲身が向く',
    exit: '反転上昇(2〜3回撃って離脱)', role: '定点から撃つ圧。テレグラフの基準', stage: 1 },
  { n: 6, slug: 'sandworm', name: 'サンドワーム', en: 'SANDWORM', hp: '3', gate: '地中・任意', num: 3,
    look: '砂を割って出る蛇腹。潜行中は砂煙だけが動く',
    move: '砂中を潜行して自機へ寄り、任意の位置で浮上', atk: '浮上後に放射状3発', tel: '砂煙が盛り上がる',
    exit: '横流れ', role: '潜行中は無敵かつ判定なし。どこから出るかを読む', stage: 2 },
  { n: 7, slug: 'sidecar', name: 'サイドカー', en: 'SIDECAR', hp: '2', gate: '前左/前右', num: 4,
    look: '二人乗り。後席が荷物を抱えている',
    move: '左右に大きく往復しながらゆっくり降下', atk: '山なりの投擲。移動先を狙う', tel: '後席が振りかぶる',
    exit: '横流れ', role: '止まっていると当たる。動き続けさせる', stage: 2 },
  { n: 8, slug: 'mirage', name: 'ミラージュ', en: 'MIRAGE', hp: '4', gate: '後左/後右', num: 3,
    look: '自機とよく似たシルエットのバギー',
    move: '自機の左右の動きを反転して真似る', atk: '一定間隔で現在地へ1発', tel: '減速+フラッシュ',
    exit: '反転上昇', role: '動くほど正面に来る。止まると当てられる', stage: 3 },
  { n: 9, slug: 'chaser', name: 'チェイサー', en: 'CHASER', hp: '4', gate: '後左/後右のみ', num: 3,
    look: '前傾したバイク。ライダーが身を伏せている',
    move: '回り込んで自機の真横に並走しようとする', atk: '並走が成立してから横撃ち', tel: '速度を合わせる',
    exit: '横流れ', role: '並走を許すと撃たれる。位置取りを崩しに来る', stage: 3 },
  { n: 10, slug: 'runner', name: 'ランナー', en: 'RUNNER', hp: '5', gate: '正面/前左/前右', num: 3,
    look: '荷台に何か積んだトラック',
    move: '降下 → 中程で停止 → 引き返す', atk: '反転直前に後方へ2発', tel: '停止が予備動作',
    exit: '反転上昇', role: '深追いを罰する', stage: 4 },
  { n: 11, slug: 'bomber', name: 'ボマー', en: 'BOMBER', hp: '2', gate: '前左/前右/正面', num: 4,
    look: '燃料タンクを抱えた小型機',
    move: '高速降下し、画面中程で自壊する', atk: '自壊時に放射状の破片', tel: '減速して膨らむ',
    exit: '(自壊)', role: '倒せば爆発しない。撃つ判断そのものが攻略', stage: 4 },
  { n: 12, slug: 'monolith', name: 'モノリス', en: 'MONOLITH', hp: '6', gate: '正面のみ', num: 3,
    look: '石像を積んだ低床トレーラー。石像の口が開く',
    move: '低速でまっすぐ降りてくる', atk: 'リング状に等間隔の弾', tel: '口が開く(長い)',
    exit: '直下', role: '弾の隙間を抜ける快感。敵弾8発上限を1体で使う', stage: 6 },
  { n: 13, slug: 'wheelsaw', name: 'ホイールソー', en: 'WHEEL SAW', hp: '破壊不能', gate: '前左/前右', num: 3,
    look: '巨大な鋸輪。濃度4の塊',
    move: '左右の画面端で跳ね返りながら降りてくる', atk: 'なし', tel: '—',
    exit: '直下', role: '「撃てないものがある」を教える。避ける腕だけを問う', stage: 1 },
  { n: 14, slug: 'mother', name: 'マザー', en: 'MOTHER', hp: '5', gate: '正面のみ', num: 3,
    look: '後部ハッチのある大型トレーラー',
    move: 'ゆっくり降下しながら左右へ', atk: 'ハッチからスキャッターを連続射出', tel: '後部ハッチが開く',
    exit: '弧離脱', role: '放置すると増える。優先度の判断を迫る', stage: 2 },
  { n: 15, slug: 'lance', name: 'ランス', en: 'LANCE', hp: '3', gate: '画面の左右端・専用', num: 4,
    look: '長い槍を構えた騎手',
    move: '画面の左右から水平に突進してくる', atk: 'なし(体当たり)', tel: '画面端で光る',
    exit: '横流れ(反対側へ抜ける)', role: '縦の動きに慣れた目を横から刺す', stage: 5 },
  { n: 16, slug: 'harvester', name: 'ハーベスタ', en: 'HARVESTER', hp: '12', gate: '正面のみ', num: 1,
    look: '巨大な収穫機。画面幅の半分弱を占める',
    move: '極めてゆっくり降下', atk: '複数の砲口が順番に波状発射', tel: '砲口が順に光る',
    exit: '(撃破のみ)', role: '中ボス手前の壁。弱点は1か所で、そこ以外は硬い', stage: 5 },
];

const EXTRA = [
  { slug: 'player_buggy', name: '自機(バギー)', kind: 'player' },
  { slug: 'obstacle_rock', name: '岩', kind: 'obstacle' },
  { slug: 'obstacle_fence', name: '柵', kind: 'obstacle' },
  { slug: 'obstacle_cactus', name: 'サボテン', kind: 'obstacle' },
  { slug: 'boss_rival', name: 'ボス(ライバル)', kind: 'boss' },
];

// art/generated/<file>.js から WIDTH / HEIGHT / データ配列を取り出す。
// 生成物は `export const NAME = [ ... ];` の素直な形なので、正規表現で足りる。
function loadArt(file) {
  const src = readFileSync(join(ROOT, 'art', 'generated', file + '.js'), 'utf8');
  const num = (suffix) => {
    const m = src.match(new RegExp(`export const [A-Z_0-9]+_${suffix}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const arr = src.match(/export const [A-Z_0-9]+\s*=\s*\[([\s\S]*?)\]/);
  if (!arr) throw new Error(`データが見つからない: ${file}`);
  const data = arr[1].split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
  const w = num('WIDTH') ?? 16;
  const h = num('HEIGHT') ?? 16;
  return { w, h, data };
}

const art = {};
for (const e of ENEMIES) art['enemy_' + e.slug] = loadArt('enemy_' + e.slug);
for (const e of EXTRA) art[e.slug] = loadArt(e.slug);

const STAGE_NAME = { 1: '荒野', 2: 'ジャングル', 3: 'オアシス', 4: '火山', 5: '海の上', 6: '洞窟' };

// 幅32pxを超える大型(ハーベスタ)は、横に押し広げずグリッド全幅のカードにする
const card = (e) => `
    <article class="card${art['enemy_' + e.slug].w > 32 ? ' wide' : ''}" id="e${e.n}">
      <div class="art"><canvas data-art="enemy_${e.slug}"></canvas></div>
      <div class="body">
        <h2><span class="num">${e.n}</span>${e.name}<span class="en">${e.en}</span></h2>
        <p class="look">${e.look}</p>
        <dl>
          <dt>移動</dt><dd>${e.move}</dd>
          <dt>攻撃</dt><dd>${e.atk}</dd>
          <dt>予備動作</dt><dd>${e.tel}</dd>
          <dt>離脱</dt><dd>${e.exit}</dd>
          <dt>出現口</dt><dd>${e.gate}</dd>
        </dl>
        <p class="role">${e.role}</p>
        <ul class="meta">
          <li>耐久 <b>${e.hp}</b></li>
          <li>編成 <b>${e.num}機</b></li>
          <li>初出 <b>S${e.stage} ${STAGE_NAME[e.stage]}</b></li>
        </ul>
      </div>
    </article>`;

const extraCard = (e) => `
    <article class="card small">
      <div class="art"><canvas data-art="${e.slug}"></canvas></div>
      <div class="body"><h2>${e.name}</h2></div>
    </article>`;

process.stdout.write(`<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BAGULAS 敵一覧</title>
<style>
  :root {
    --bg: #0f380f; --panel: #163f16; --line: #2b5a2b;
    --ink: #9bbc0f; --dim: #7a9a2a; --accent: #c6de6a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px;
    background: var(--bg); color: var(--ink);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    line-height: 1.7;
  }
  header { max-width: 1100px; margin: 0 auto 32px; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; letter-spacing: .08em; }
  header p { margin: 0; color: var(--dim); font-size: .85rem; }
  header a { color: var(--accent); }
  .grid {
    max-width: 1100px; margin: 0 auto;
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  }
  .card {
    display: flex; gap: 14px; padding: 14px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  }
  .art { flex: 0 0 auto; }
  canvas { image-rendering: pixelated; display: block; background: #0b2a0b; border-radius: 3px; }
  .body { min-width: 0; }
  h2 { font-size: 1rem; margin: 0 0 6px; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .num {
    font-size: .7rem; color: var(--bg); background: var(--dim);
    border-radius: 3px; padding: 1px 6px;
  }
  .en { font-size: .7rem; color: var(--dim); letter-spacing: .1em; }
  .look { margin: 0 0 8px; font-size: .82rem; color: var(--accent); }
  dl { margin: 0 0 8px; display: grid; grid-template-columns: 5.5em 1fr; gap: 2px 8px; font-size: .78rem; }
  dt { color: var(--dim); }
  dd { margin: 0; }
  .role { margin: 0 0 8px; font-size: .78rem; color: var(--dim); border-left: 2px solid var(--line); padding-left: 8px; }
  .meta { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; padding: 0; font-size: .72rem; color: var(--dim); }
  .meta b { color: var(--ink); font-weight: 600; }
  .card.small { align-items: center; }
  .card.wide { grid-column: 1 / -1; }
  canvas { max-width: 100%; height: auto; }
  h3 { max-width: 1100px; margin: 40px auto 12px; font-size: .95rem; color: var(--dim); letter-spacing: .08em; }
  footer { max-width: 1100px; margin: 48px auto 0; font-size: .75rem; color: var(--dim); }
  @media (max-width: 480px) { .card { flex-direction: column; } }
</style>
</head>
<body>
<header>
  <h1>BAGULAS 敵一覧</h1>
  <p>全16種。グラフィックは実際にゲームで使っているドット絵データをそのまま描画している(4階調)。
  設計の詳細は <a href="https://github.com/kathoc/bagulas/blob/main/docs/enemies.md">docs/enemies.md</a> /
  ゲーム本体は <a href="https://sonohoka.sakura.ne.jp/bagulas/">こちら</a>。</p>
</header>

<div class="grid">
${ENEMIES.map(card).join('\n')}
</div>

<h3>そのほか</h3>
<div class="grid">
${EXTRA.map(extraCard).join('\n')}
</div>

<footer>自動生成: tools/build_enemy_sheet.mjs — 表の内容は docs/enemies.md を正とする。</footer>

<script>
const ART = ${JSON.stringify(art)};
const PALETTE = ['#9bbc0f', '#8bac0f', '#306230', '#0f380f'];
const SCALE = 5;
for (const cv of document.querySelectorAll('canvas[data-art]')) {
  const a = ART[cv.dataset.art];
  if (!a) continue;
  cv.width = a.w * SCALE;
  cv.height = a.h * SCALE;
  const ctx = cv.getContext('2d');
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const v = a.data[y * a.w + x];
      if (v === 4) continue;            // 透明
      ctx.fillStyle = PALETTE[v];
      ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
}
</script>
</body>
</html>
`);
