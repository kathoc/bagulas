// enemies.js — 敵編隊・敵弾・障害物のスポーン/更新/描画/被弾処理（Step3）
// 8.8固定小数点のみ使用。update系関数内での new/{}/[]/push/map/filter は禁止。
// 三角関数・Math.random・sqrt は使わない。
import { f, toPx, fmul, DIR16, aim16 } from './fixed.js';
import { rndRange } from './rng.js';
import {
  ENEMIES,
  ENEMY_BULLETS,
  OBSTACLES,
  EFFECTS,
  SMOKE,
  spawn,
  forEach,
  forEachFrom,
} from './entities.js';
import {
  pushMeta16,
  pushSprite,
  drawBGObject,
  spriteBudgetLeft,
  isOffRoadAt,
  SAFE_ONROAD_LEFT_PX,
  SAFE_ONROAD_RIGHT_PX,
} from './gfx.js';
import {
  TILE16_ROCK,
  TILE16_FENCE,
  TILE16_CACTUS,
  TILE16_EXPLOSION_0,
  TILE16_EXPLOSION_1,
  TILE16_EXPLOSION_2,
  TILE16_ENEMY_SCATTER,
  TILE16_ENEMY_DRIFTER,
  TILE16_ENEMY_REAPER,
  TILE16_ENEMY_GUNWAGON,
  TILE16_ENEMY_WHEELSAW,
  TILE16_ENEMY_HOPPER,
  TILE16_ENEMY_SANDWORM,
  TILE16_ENEMY_SIDECAR,
  TILE16_ENEMY_MOTHER,
  TILE16_ENEMY_MIRAGE,
  TILE16_ENEMY_CHASER,
  TILE_BULLET_ENEMY,
  TILE_SMOKE,
} from './tiles.js';
import { STAGES, FORMATIONS, OBSTACLE_KINDS, GATES, applyLoop } from './stages.js';

// 敵種別（ENEMIES.kind に格納する内部enum）。段階3で5種を実装。
// 残り11種を後で追加する前提で、以降は「kind→関数」のテーブル(ENEMY_INIT_BY_KIND/ENEMY_MOVE_BY_KIND/
// ENEMY_CAN_FIRE_BY_KIND)でディスパッチし、if の羅列にしない。
const KIND_SCATTER = 0;
const KIND_DRIFTER = 1;
const KIND_REAPER = 2;
const KIND_GUNWAGON = 3;
const KIND_WHEELSAW = 4;
// 段階3グループ2(docs/enemies.md #4,#6,#7,#14)
const KIND_HOPPER = 5;
const KIND_SANDWORM = 6;
const KIND_SIDECAR = 7;
const KIND_MOTHER = 8;
// 段階3グループ3(docs/enemies.md #8,#9)。背後出現(BACK_LEFT/BACK_RIGHT)を初めて実地に使う2種。
const KIND_MIRAGE = 9;
const KIND_CHASER = 10;

// formation名(stages.js) → kind番号。wave.formationの値からここで解決する。
const KIND_BY_FORMATION = {
  [FORMATIONS.SCATTER]: KIND_SCATTER,
  [FORMATIONS.DRIFTER]: KIND_DRIFTER,
  [FORMATIONS.REAPER]: KIND_REAPER,
  [FORMATIONS.GUNWAGON]: KIND_GUNWAGON,
  [FORMATIONS.WHEELSAW]: KIND_WHEELSAW,
  [FORMATIONS.HOPPER]: KIND_HOPPER,
  [FORMATIONS.SANDWORM]: KIND_SANDWORM,
  [FORMATIONS.SIDECAR]: KIND_SIDECAR,
  [FORMATIONS.MOTHER]: KIND_MOTHER,
  [FORMATIONS.MIRAGE]: KIND_MIRAGE,
  [FORMATIONS.CHASER]: KIND_CHASER,
};

// kindごとの静的データ(タイル)。耐久/出現口/編成数はwave側(stages.js)が持つためここには置かない。
const ENEMY_DEF_BY_KIND = [
  { tile: TILE16_ENEMY_SCATTER },
  { tile: TILE16_ENEMY_DRIFTER },
  { tile: TILE16_ENEMY_REAPER },
  { tile: TILE16_ENEMY_GUNWAGON },
  { tile: TILE16_ENEMY_WHEELSAW },
  { tile: TILE16_ENEMY_HOPPER },
  { tile: TILE16_ENEMY_SANDWORM },
  { tile: TILE16_ENEMY_SIDECAR },
  { tile: TILE16_ENEMY_MOTHER },
  { tile: TILE16_ENEMY_MIRAGE },
  { tile: TILE16_ENEMY_CHASER },
];

// 発射するkindかどうか。false のkindはatkTimerの減算/発射パイプラインへ一切触れない
// (スキャッター/リーパー/ホイールソーは攻撃なし。無限に減算させて誤発火しないようここで断つ)。
// ホッパー/サンドワームもfalse: どちらも共通の「減速→フラッシュ→発射」atkTimerパイプラインに
// 乗らない専用の予備動作(着地の停止/砂煙の盛り上がり)を持つため、moveHopper/updateSandwormPre側で
// 独自にfireCountを管理する(下記コメント参照)。
// 段階3グループ3(MIRAGE/CHASER): 両方とも一撃離脱(1回撃って離脱)。CHASERは並走成立前は発射
// パイプライン自体をブロックする(下記ENEMY_FIRE_BLOCK_BY_KIND参照)。
const ENEMY_CAN_FIRE_BY_KIND = [false, true, false, true, false, false, false, true, true, true, true];

// 雑魚敵は一撃離脱(docs/enemies.md)。「離脱までに撃てる回数」をkind別に持つ。
// GATE_X_MIN/GATE_X_SPREADと同じ「基準値+rndRangeでの上乗せ」の形にして、後で残り11種
// (ハーベスタ/マザーの複数回射出など)を足すときも同じ形で拡張できるようにする。
// 発射しないkind(SCATTER/REAPER/WHEELSAW)は値を持っていても実害がない
// (ENEMY_CAN_FIRE_BY_KINDがfalseなので、この配列自体が参照されない)。
// ホッパー/サンドワームはこの配列を参照しない(ENEMY_CAN_FIRE_BY_KINDがfalseのため
// initEnemyFromWaveがfireLimit=0で決め打ちする)。実際の発射回数上限はHOPPER_FIRE_LIMIT/
// 専用の1回きり処理でkind固有に管理する(下記)。
const ENEMY_FIRE_LIMIT_MIN_BY_KIND = [0, 1, 0, 2, 0, 0, 0, 1, 3, 1, 1]; // SIDECAR=1回, MOTHER=3回起点, MIRAGE/CHASER=1回
const ENEMY_FIRE_LIMIT_SPREAD_BY_KIND = [1, 1, 1, 2, 1, 1, 1, 1, 2, 1, 1]; // MOTHERは+0..1で3〜4回に散らす

// 発射回数ベースの離脱が「自機が至近距離(±32px)で居座り続け、近距離発射抑止で撃てないまま
// fireCountがfireLimitへ到達しない」せいで永久に成立しない事態(docs/spec.md「自機の可動範囲」
// 節の注意書き参照)への保険。leaveTimer(spawnからの経過フレーム、ブロック中も含め毎フレーム
// 加算=updateOneEnemy参照)がここの値に達したら、発射回数を待たずに強制離脱させる。
// 0=このバックストップを使わない(既定)。「画面上部に居座る」GUNWAGON/MOTHERのみ設定する。
// 値の根拠: 1周期はFIRE_INTERVAL_BASE(150)+jitter(0〜39)=最大189フレーム
// (この中にTELEGRAPH_SLOWDOWN_FRAMES=64の予備動作も含まれるため別途加算不要)。
// GUNWAGON: fireLimitは2〜3(ENEMY_FIRE_LIMIT_MIN/SPREAD[3]=2,2)なので、通常プレイ(至近距離で
// 張り付かない)での発射完了は最悪でも 3×189=567フレーム。ここへ余裕を持たせ900フレーム(≒15秒)。
// MOTHER: fireLimitは3〜4(同[8]=3,2)なので最悪 4×189=756フレーム。同様に余裕を持たせ1200フレーム(≒20秒)。
// どちらも「通常プレイでは発射回数側が先に成立し、時間側は至近距離での張り付きに対してのみ
// バックストップとして働く」ことを検証ステップで実測して確認する(このコメントは設計時点の
// 見積りであり、実測結果と乖離があれば値を調整すること)。
const ENEMY_LEAVE_TIME_LIMIT_BY_KIND = [0, 0, 0, 900, 0, 0, 0, 0, 1200, 0, 0]; // GUNWAGON=900f, MOTHER=1200f

// 発射上限に達した個体が離脱する時にkind固有の後始末(移動状態の切替)を行う関数テーブル。
// 何もしないkindはleaveNoneを使う(ENEMY_MOVE_BY_KINDと同じ並び順: SCATTER/DRIFTER/REAPER/GUNWAGON/WHEELSAW)。
function leaveNone() {}

// 画面内判定(「一度でも画面内に入ったか」の判定用)。既存の画面外消滅判定(下端160px/上端-16px)と
// 整合する範囲を採る。x方向はREAPER_X_EXIT_MIN/MAX_PXと同じ余裕(スプライト16px分)を使う。
const ONSCREEN_X_MIN_PX = -16;
const ONSCREEN_X_MAX_PX = 176;
const ONSCREEN_Y_MIN_PX = -16;
const ONSCREEN_Y_MAX_PX = 160;

// EFFECTS.kind の使い分け（weapons.js の kind=0=ダイナマイト爆発と衝突しない値を使う）
export const EFFECT_KIND_ENEMY_EXPLOSION = 1; // 敵/障害物撃破の爆発
export const EFFECT_KIND_DEBRIS = 2; // 撃破時の破片パーティクル
// 爆発の複数パターン演出用タイル差し替え列（実素材 explosion.png 由来の16x16メタスプライト3枚。
// 小→大→散の順。boss.jsの撃破演出も同じ配列を流用する）
export const ENEMY_EXPLOSION_TILES = [TILE16_EXPLOSION_0, TILE16_EXPLOSION_1, TILE16_EXPLOSION_2];

// --- 敵の移動・発射チューニング値（すべて整数/8.8固定小数点） ---
const ENEMY_VY = 96; // 敵の下降速度。スクロール速度の1/2(128)以下に抑え、横移動を主な脅威として読ませる
const V_SPACING = f(16); // V字の左右オフセット単位。横への広がりを強める
const V_MAX_OFFSET = f(32); // waveBaseX(24..120px)から見て完全に画面外へ居座らない範囲でclamp
const V_Y_STEP = f(6); // V字の前後(見た目上の奥行き)ずらし単位
const COLUMN_Y_SPACING = f(20); // 縦列の初期縦間隔(ドリフターの縦列フェーズ/ホイールソーの入場間隔で共用)
const SNAKE_STEP = 128; // 振れ幅2倍に合わせてstepも2倍にし、半周期フレーム数をほぼ維持する(ドリフター蛇行フェーズ)
const SNAKE_AMPLITUDE = f(40); // 蛇行の振れ幅。anchorXから±40pxで大きく横へ振る

// --- ドリフター専用: 縦列→蛇行の切替しきい値 ---
const DRIFTER_SNAKE_START_Y = f(72); // 画面高144pxの半分あたり(目安どおり)を超えたら蛇行に切り替える
const DRIFTER_TRANSITIONED_FLAG = 2; // e.flags bit1: 蛇行フェーズへ切替済み
const DRIFTER_LEAVING_FLAG = 4; // e.flags bit2: 発射上限(1回)に到達し離脱シーケンスへ入った

// --- リーパー専用: 斜めに流れて短い滞在で抜ける ---
const REAPER_VY = 112; // ENEMY_VY(96)よりやや速め。128以下は守りつつ「速い」印象を出す
const REAPER_VX = f(1); // 1px/frame。横方向の移動が支配的になり、y到達より先にx方向で画面外へ抜ける
const REAPER_ENTRY_X_SPACING = f(6); // メンバーごとに互い違いに軽くxをずらし重なりを避ける(V字と同じ考え方)
const REAPER_X_EXIT_MIN_PX = -16; // これより左は画面外
const REAPER_X_EXIT_MAX_PX = 176; // これより右は画面外(スプライト16px分の余裕を見る)

// --- ガンワゴン専用: 画面上部に居座り左右へ滑る。降りてこない ---
const GUNWAGON_TARGET_Y = f(24); // 居座りy。目安f(16)〜f(32)の中間
const GUNWAGON_SLIDE_VX = 80; // 左右へ滑る速度(ENEMY_VYと同オーダー)
const GUNWAGON_MIN_X = f(0);
const GUNWAGON_MAX_X = f(144); // 画面幅160-スプライト幅16
const GUNWAGON_SETTLED_FLAG = 2; // e.flags bit1: 定位置(GUNWAGON_TARGET_Y)へ到達済み
const GUNWAGON_LEAVING_FLAG = 4; // e.flags bit2: 退場シーケンス開始済み(vyを負にして上へ抜けさせた)
// 退場トリガはフレーム数居座りではなく発射回数基準(ENEMY_FIRE_LIMIT_MIN/SPREAD_BY_KIND参照)。
// 段階3当初のGUNWAGON_STAY_FRAMES(720f固定居座り)は「雑魚敵は一撃離脱」の発射回数基準へ差し替え、
// 未使用になったため削除した。

// --- ホイールソー専用: 左右端で跳ね返りながら降下。破壊不能 ---
const WHEELSAW_VX = 96; // 跳ね返りの横速度。ENEMY_VYと同オーダー
const WHEELSAW_MIN_X = f(0);
const WHEELSAW_MAX_X = f(144); // 画面幅160-スプライト幅16(スプライト半分を考慮したclamp範囲)

// --- ホッパー専用: 跳ねながら降下。着地の瞬間だけ停止し、その硬直中に真下へ1発(docs/enemies.md #4) ---
const HOPPER_AIR_FRAMES = 36; // 1跳躍の滞空フレーム数。ENEMY_VY(96)×36/256≈13.5px/跳躍で降下する
const HOPPER_LAND_FRAMES = 30; // 着地硬直の長さ。docs「障害物拘束30フレーム=0.5秒」と同じ長さを
// 「狙って撃てる」基準として採用する(実測はverify手順で確認・報告する)。
const HOPPER_LANDED_FLAG = 1; // e.flags bit0: 着地硬直中
const HOPPER_FIRE_LIMIT = 1; // 一撃離脱: 最初の着地硬直で1回だけ真下へ撃つ
const HOPPER_BULLET_DOWN_DIR = 8; // DIR16[8] = 真下固定(自機を狙わない。docs「真下へ1発」)

// --- サンドワーム専用: 潜行(無敵・判定なし)→予告(砂煙)→浮上して放射3発(docs/enemies.md #6) ---
// 出現口の概念を持たないため、スポーン直後は不可視状態でENEMIESプールへ入れる(無敵・判定なしは
// damageEnemy/checkOneEnemyAgainstCurBullet/checkEnemyVsPlayer側のisEnemyIntangible判定で実現する)。
const SANDWORM_SUBMERGED_FLAG = 1; // e.flags bit0: 潜行中(不可視・無敵・判定なし)
const SANDWORM_STAGGER_FRAMES = 30; // 編隊内メンバーごとに出現をずらす(3体同時浮上を避ける)
const SANDWORM_HOMING_FRAMES = 40; // 潜行接近フェーズの長さ(不可視のまま自機xへ寄る)
const SANDWORM_TELEGRAPH_FRAMES = 50; // 予告(砂煙)フェーズの長さ。浮上までの猶予として実測・報告する
const SANDWORM_SMOKE_INTERVAL = 10; // 砂煙を吹くフレーム間隔(予告フェーズ中に5回盛り上がる)
const SANDWORM_HOMING_VX = f(1); // 潜行接近の横移動速度(1px/frame)
const SANDWORM_HOME_Y = f(96); // 潜行/浮上のy(自機の可動域Y_MIN64..Y_MAX128に近い帯)
const SANDWORM_ENTRY_SPACING = f(20); // 編隊内メンバーの初期x間隔(重なり回避)

// --- サイドカー専用: 左右に大きく往復しながらゆっくり降下。移動先を狙う山なりの投擲(docs/enemies.md #7) ---
const SIDECAR_VY = 72; // ENEMY_VY(96)よりゆっくり降下させる(docs「ゆっくり降下」)
const SIDECAR_AMPLITUDE = f(36); // 往復の振れ幅(ドリフターの蛇行より大きく=「大きく往復」)
const SIDECAR_STEP = 96; // 往復速度
const SIDECAR_LEAVING_FLAG = 2; // e.flags bit1: 発射済みで離脱シーケンスへ入った(bit0は往復方向で使用中)
const SIDECAR_LEAD_FRAMES = 30; // 自機の「移動先」を先読みする時間(フレーム)
const SIDECAR_BULLET_SPEED = 2; // 通常の敵弾と同オーダー
const SIDECAR_LOB_ARC_BOOST = f(1); // 直線照準よりさらに上向きに初速を足し、重力で弧を描かせる
const SIDECAR_LOB_GRAVITY = 10; // 8.8固定小数点。毎フレームvyへ加算(weapons.jsのDYNAMITE_GRAVITY=16と同系統)
const ENEMY_BULLET_KIND_LOB = 1; // ENEMY_BULLETS.kindの特殊値: 山なり(重力あり)。通常弾は0のまま

// --- マザー専用: ゆっくり降下しながら左右へ。ハッチからスキャッターを連続射出(docs/enemies.md #14) ---
const MOTHER_TARGET_Y = f(24); // 居座り開始y(ガンワゴンと同じ帯)
const MOTHER_DRIFT_VY = 24; // 居座り後もゆっくり降下し続ける速度(docs「ゆっくり降下しながら左右へ」)
const MOTHER_SWAY_AMPLITUDE = f(28); // 左右の揺れ幅(ガンワゴンの端から端スライドより控えめ)
const MOTHER_SWAY_STEP = 64; // 揺れの速さ
const MOTHER_SETTLED_FLAG = 2; // e.flags bit1: 居座り位置へ到達済み(bit0は揺れ方向で使用中)
const MOTHER_LEAVING_FLAG = 4; // e.flags bit2: 射出上限に到達し離脱シーケンスへ入った
const MOTHER_CHILD_HP = 1; // 射出されたスキャッターの耐久。プール占有時間を短く保つためあえて低くする

// --- ミラージュ専用: 自機の左右の動きを反転して真似る(docs/enemies.md #8) ---
// updateEnemies()が毎フレーム算出するcurPlayerVX(前フレームとの差分)をそのまま符号反転して
// e.vxへ使う。自機自身が「慣性なし・即応」(spec.md)な設計のため、離散的な速度変化をそのまま
// 反転で追従させても自機と同じ体感の「即応」になり、カクつき/張り付きにはならない想定
// (検証で気持ち悪ければ減衰を入れる。その場合は理由を報告する)。
const MIRAGE_MIN_X = f(0);
const MIRAGE_MAX_X = f(144); // 画面幅160-スプライト幅16。GUNWAGON/WHEELSAWと同じ可動域
const MIRAGE_LEAVING_FLAG = 2; // e.flags bit1: 発射済みで離脱シーケンスへ入った(追従を止める)

// --- チェイサー専用: 回り込んで自機の真横に並走し、成立後に横撃ち(docs/enemies.md #9) ---
const CHASER_SIDE_OFFSET_PX = f(40); // 並走時の自機からの横オフセット。isPlayerTooCloseToFire
// (中心距離x/yとも32px以内で発射禁止)のx方向32pxしきい値を確実に超える値を採る。
// これにより「並走成立=撃てる」を成立させたまま、既存の近接発射抑止と衝突しない。
const CHASER_MIN_X = f(0);
const CHASER_MAX_X = f(144);
const CHASER_VX_SEEK = f(1); // 横方向の回り込み速度(1px/frame)
const CHASER_VY_MAX = 128; // 縦速度上限。docs/spec.md「敵縦速度はスクロールの1/2(128)以下」を厳守
const CHASER_ALIGN_DY_PX = 12; // 自機とのy差がこの範囲内なら「並走帯」に入っているとみなす
const CHASER_ALIGN_FRAMES_REQUIRED = 20; // 並走帯に連続でこのフレーム数留まったら並走成立
const CHASER_ENTRY_SPACING = f(10); // 編隊内メンバーの初期x間隔(重なり回避)
const CHASER_PAIRED_FLAG = 1; // e.flags bit0: 並走成立済み(観測可能な個体状態)
const CHASER_LEAVING_FLAG = 2; // e.flags bit1: 発射済みで離脱シーケンスへ入った
const CHASER_SIDE_RIGHT_FLAG = 4; // e.flags bit2: 出現側(BACK_RIGHT)基準で自機の右側へ回り込む個体

// 出現口(GATES.*)ごとの編隊アンカーx範囲(px)。index は GATES の値と対応する
// (FRONT_LEFT, FRONT_RIGHT, FRONT_CENTER, BACK_LEFT, BACK_RIGHT, BACK_AUTO, UNDERGROUND)。
// BACK_AUTOは解決後の値でしか引かない。UNDERGROUND(サンドワーム)はinitSandwormが参照しない
// (自機位置基準で独自にx/yを決めるため)が、配列の対応関係を崩さないよう値だけは埋めておく。
const GATE_X_MIN = [8, 96, 64, 8, 96, 64, 64];
const GATE_X_SPREAD = [49, 49, 33, 49, 49, 33, 33]; // rndRangeに渡す範囲

// 出現口が背後(下端から追い上げ)かどうか。1=背後。indexはGATES.*と対応
const GATE_IS_BACK = [0, 0, 0, 1, 1, 0, 0];

const WAVE_GAP_MIN = 90; // ウェーブ間の空き下限(フレーム)
const WAVE_GAP_SPREAD = 61; // rndRange(61)で0..60を足し、90..150の空きにする
const SCREEN_CENTER_X = f(80); // 自機の左右寄りを判定する基準(画面幅160の中央)

// 発射間隔の基本値(フレーム)。予備動作(TELEGRAPH_SLOWDOWN_FRAMES=64)より十分長く取る。
// 90だと1周期90..130フレームのうち64が減速フェーズになり、実測で「減速中の方が長い」状態
// (通常19067サンプルに対し予備動作26350サンプル)になっていた。減速が常態だと
// 「あ、撃つな」という速度差が読めなくなるので、通常速度が多数派になる長さにする。
const FIRE_INTERVAL_BASE = 150;
const FIRE_INTERVAL_JITTER = 40; // 発射間隔のばらつき幅
const TELEGRAPH_SLOWDOWN_FRAMES = 64; // 発射64フレーム前から先に減速し、その後20フレーム前から点滅する
const TELEGRAPH_SLOWDOWN_NUM = 0x0040; // 予備動作中の縦速度係数(1/4)。横蛇行も同係数で減衰させ、はっきり分かる速度差を出す
const TELEGRAPH_FRAMES = 20; // 発射の何フレーム前からフラッシュ構えモーションに入るか
const TELEGRAPH_BLINK_SHIFT = 2; // atkTimer>>この値 & 1 で4フレーム周期の点滅を作る
const SHAKE_PERIOD_SHIFT = 3; // オフロード揺れの周期(game.jsのSHAKE_PERIOD_SHIFTと同じ値)。8フレームごとに反転

// オフロード時の速度係数 2/3 ≈ 0x00AB(171/256)。playerと同じ係数(game.jsのPLAYER_SPEED_OFFROADと同義)。
// e.vyは生成時に一度だけ設定される定数のため、オフロード判定時にvy自体を書き換えず、
// 移動量計算のたびにローカルで係数をかけて求める（onroad復帰時の巻き戻しが不要になる）。
const ENEMY_SPEED_OFFROAD_NUM = 0x00ab;
const ENEMY_BULLET_SPEED = 2; // 敵弾速度(px/frame、整数)
export const ENEMY_BULLET_TILE = TILE_BULLET_ENEMY; // 敵弾専用タイル(最暗色index3)。boss.jsも同じ弾タイルを流用する
const ENEMY_FIRE_PROXIMITY = f(32); // 自機/敵の中心距離がx/yとも32px以内なら発射しない
const SPRITE_CENTER_OFFSET = f(8); // 16x16スプライトの中心。近距離発射抑止はヒットボックスではなく見た目中心で判定する

const OBSTACLE_HP = 3; // 破壊可障害物の耐久

const ENEMY_SCORE_VALUE = 100;
const OBSTACLE_SCORE_VALUE = 50;
// リーパー全滅ボーナス: ENEMY_SCORE_VALUE(100)の3倍=300。5機編隊を「抜けきる前に全滅」させる
// 腕前を、体当たりのみのスキャッター(撃破のみ100pt)より明確に高く評価する値として採用。
// docs/enemies.mdの役割記述「抜けきる前に5台倒すと高得点」に基づく(具体的な倍率は本実装での採用値)。
const REAPER_ALLKILL_BONUS = ENEMY_SCORE_VALUE * 3;

const HIT_FLASH_FRAMES = 2; // 被弾時の白フラッシュ表示フレーム数

// --- リーパー全滅ボーナスの追跡用スロット(段階3の決定事項: makePoolと同様の固定長事前確保配列) ---
// 同時に複数のリーパー編隊が並存する余地(ウェーブ空き90〜150フレームの間に前編隊がまだ残っている等)を
// 見込んで4スロット確保する。frame内でのnew/{}生成を避けるため、モジュール読み込み時に1回だけ確保し、
// 以降はスロットを使い回す(makePool方式そのまま流用)。
const REAPER_TRACK_SLOTS = 4;
const reaperTrack = [];
for (let i = 0; i < REAPER_TRACK_SLOTS; i++) {
  reaperTrack.push({ active: false, formationId: 0, total: 0, killed: 0, accounted: 0, escaped: false });
}

// 新しいリーパー編隊の追跡を開始する(wave先頭メンバーのスポーン時に1回だけ呼ぶ)。空きスロットが無ければ
// (通常起こらない想定: 4編隊同時分)何もしない=その編隊はボーナス対象外になるだけで安全側に倒れる。
function reaperTrackStart(formationId, total) {
  for (let i = 0; i < REAPER_TRACK_SLOTS; i++) {
    const t = reaperTrack[i];
    if (!t.active) {
      t.active = true;
      t.formationId = formationId;
      t.total = total;
      t.killed = 0;
      t.accounted = 0;
      t.escaped = false;
      return;
    }
  }
}

function reaperTrackFind(formationId) {
  for (let i = 0; i < REAPER_TRACK_SLOTS; i++) {
    const t = reaperTrack[i];
    if (t.active && t.formationId === formationId) {
      return t;
    }
  }
  return null;
}

// リーパーが自弾で撃破された時に呼ぶ。戻り値: 全滅ボーナスを与えるべきならtrue。
function reaperTrackOnKill(formationId) {
  const t = reaperTrackFind(formationId);
  if (!t) {
    return false;
  }
  t.killed += 1;
  t.accounted += 1;
  let bonus = false;
  if (t.accounted >= t.total) {
    bonus = !t.escaped && t.killed === t.total;
    t.active = false; // 編隊の決着がついたのでスロットを解放し、次の編隊に使い回す
  }
  return bonus;
}

// リーパーが撃たれずに画面外へ抜けた時に呼ぶ。以降そのformationIdは全滅ボーナス対象外になる。
function reaperTrackOnEscape(formationId) {
  const t = reaperTrackFind(formationId);
  if (!t) {
    return;
  }
  t.escaped = true;
  t.accounted += 1;
  if (t.accounted >= t.total) {
    t.active = false;
  }
}

function resetReaperTrack() {
  for (let i = 0; i < REAPER_TRACK_SLOTS; i++) {
    reaperTrack[i].active = false;
  }
}

// --- モジュールスコープの進行状態（配列生成なしのプレーン変数。resetEnemies()で初期化） ---
let sectionIndex = 0; // 0=prelude, 1=main, 2=boss到達(以降何もしない)
let sectionStartDistance = 0; // 現在のセクションが始まった時点の絶対distance
let waveCursor = 0; // 現在セクション内で次にスポーンすべきwavesのindex
let obstacleCursor = 0; // 同様にobstaclesのindex
let waveMemberIndex = 0; // 現在スポーン中のwaveで、すでにスポーンした体数
let waveBaseX = 0; // 現在スポーン中のwaveのx基準(8.8)
let waveGapTimer = 0; // 次のウェーブを開始できるまでの残りフレーム(90〜150)。0になるまで湧かない
let currentGate = GATES.FRONT_CENTER; // 現在/直前スポーンしたwaveで解決済みの出現口(BACK_AUTOは解決後の値のみ持つ)
let currentFormationId = 0;
let nextFormationId = 1;
let loop = 0; // 周回カウンタ。game.jsのloadStage(0)からsetLoop()で更新される

export function setLoop(n) {
  loop = n;
}

// 現在対象にしているステージ(STAGES配列のindex)。既定0=STAGES[0](荒野、M1で実プレイ可能な唯一のステージ)。
// 段階3グループ2の検証用にstartAtWave()の第3引数で切り替えられるようにする(通常プレイ経路は
// 常に0のまま触れないので、ステージ1の道中には一切影響しない)。
let curStageIndex = 0;

// updateEnemies()の引数を、毎フレームクロージャを作らずforEachコールバックへ渡すためのモジュール変数
let curPlayerX = 0;
let curPlayerY = 0;
// サイドカーの「移動先を狙う」先読みに使う自機の推定速度(8.8固定小数点、1フレームあたりの変位)。
// game.jsからは位置しか渡されないため、前フレームとの差分でここに毎フレーム算出する
// (三角関数は使わず、aim16へ渡す差分ベクトルの一部として使うだけ)。
let prevPlayerX = 0;
let prevPlayerY = 0;
let playerVelocityPrimed = false; // リセット直後の1フレーム目は差分を取らず0にする(急変を防ぐ)
let curPlayerVX = 0;
let curPlayerVY = 0;
let curScrollY = 0; // updateOneEnemy()のオフロード判定用（updateEnemiesが毎フレーム更新する）
let curDistance = 0; // drawOneEnemy()の揺れ演出の周期用（updateEnemiesが毎フレーム更新する）
// 自機死亡演出〜復活の間、世界全体が一緒にスローになって見えるための速度比。
// 8.8固定小数点(256=等倍)。game.js が (現在のscrollSpeed<<8)/基準値 | 0 で算出して渡す。
let curEnemySpeedRatio = 256;
// 死亡演出中(爆発〜スクロール停止まで)は敵のスポーンと発射を止める。game.jsから毎フレーム渡される。
let curSpawnFrozen = false;
// 障害物の今フレームの下降速度(8.8固定小数点)。現在のスクロール速度そのもの(game.js由来)を
// updateObstacles()が毎フレーム更新する。スクロールが止まれば障害物も止まる。
let curObstacleVy = 256;

function killSlot(s) {
  s.alive = false;
}

export function resetEnemies() {
  sectionIndex = 0;
  sectionStartDistance = 0;
  waveCursor = 0;
  obstacleCursor = 0;
  waveMemberIndex = 0;
  waveBaseX = 0;
  waveGapTimer = 0;
  currentGate = GATES.FRONT_CENTER;
  currentFormationId = 0;
  nextFormationId = 1;
  curStageIndex = 0; // 通常の新規ゲームは常にステージ0(荒野)から。デバッグ用startAtWaveの3引数目でのみ変わる
  playerVelocityPrimed = false;
  curPlayerVX = 0;
  curPlayerVY = 0;

  forEach(ENEMIES, killSlot);
  forEach(ENEMY_BULLETS, killSlot);
  forEach(OBSTACLES, killSlot);
  resetReaperTrack();
}

// セクション境界を跨いだかどうかを判定して進める。updateEnemies/updateObstacles両方から
// 毎フレーム呼ばれるが、境界を跨いでいなければ何もしないため冪等（二重に呼んでも安全）。
function advanceSection(distance) {
  if (sectionIndex >= 2) {
    return; // ボスセクション到達済み。以降スポーンしない
  }
  const sections = STAGES[curStageIndex].sections;
  let localDistance = distance - sectionStartDistance;
  while (sectionIndex < 2 && localDistance >= sections[sectionIndex].length) {
    sectionStartDistance += sections[sectionIndex].length;
    sectionIndex += 1;
    waveCursor = 0;
    obstacleCursor = 0;
    waveMemberIndex = 0;
    waveGapTimer = 0; // 新セクションの最初のウェーブは空き待ちなしで開始する
    localDistance = distance - sectionStartDistance;
  }
}

function vHalfIndex(memberIndex) {
  return (memberIndex + 1) >> 1;
}

// V字編隊の左右オフセット（中心0, 以降左右交互に広がる。V_MAX_OFFSETでclamp）
function vOffsetX(memberIndex) {
  if (memberIndex === 0) {
    return 0;
  }
  const half = vHalfIndex(memberIndex);
  const sign = (memberIndex & 1) === 1 ? -1 : 1;
  let off = half * V_SPACING;
  if (off > V_MAX_OFFSET) {
    off = V_MAX_OFFSET;
  }
  return sign * off;
}

// BACK_AUTOを実際の出現口へ解決する。背後タイプは原則プレイヤーが居ない側から出すため、
// 自機が画面中央より右寄りならBACK_LEFT、左寄り(または中央)ならBACK_RIGHTを選ぶ。
// curPlayerXはupdateEnemies()の先頭で毎フレーム更新済みの値を使う(wave開始フレーム時点のもの)。
function resolveGate(gate) {
  if (gate !== GATES.BACK_AUTO) {
    return gate;
  }
  return curPlayerX >= SCREEN_CENTER_X ? GATES.BACK_LEFT : GATES.BACK_RIGHT;
}

// 出現口(gate)から、前方/背後どちらの縁から入るかを解決する。現行5種は全て前方出現口のみを
// 使うため常にback=falseになるが、将来の背後タイプ追加に備えGATE_IS_BACKをそのまま参照する。
function edgeParamsForGate(gate) {
  const back = GATE_IS_BACK[gate] === 1;
  return {
    vySign: back ? -1 : 1,
    edgeY: back ? f(144) : f(-16),
    // 後続メンバーの入場を時間差にするための積み上げ方向。前方は上端の外側(さらに負)へ、
    // 背後は下端の外側(さらに正)へ積む。
    edgeStep: back ? 1 : -1,
  };
}

// --- kindごとの初期化関数(ENEMY_INIT_BY_KINDから呼ばれる) ---
// 共通フィールド(hp/flags/atkTimer/formationId/timer/tile)はinitEnemyFromWaveが先に設定済み。
// ここではkind固有のx/y/vx/vy/anchorXだけを設定する。

function initScatter(e, wave, memberIndex, gate) {
  // 元KIND_V。V字編隊で降り、中央から左右へ広がる(docs/enemies.md #1)。既存V字ロジックをそのまま流用。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX + vOffsetX(memberIndex);
  e.y = edgeY + edgeStep * vHalfIndex(memberIndex) * V_Y_STEP;
  e.vx = 0;
  e.vy = vySign * ENEMY_VY;
}

function initDrifter(e, wave, memberIndex, gate) {
  // 元KIND_COLUMN。縦列で降下し、画面中程(DRIFTER_SNAKE_START_Y)を超えたら蛇行フェーズへ切り替える
  // (切替はupdateOneEnemy側で毎フレーム判定する。ここでは縦列フェーズの初期状態だけを作る)。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX;
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.anchorX = waveBaseX; // 蛇行フェーズに入った時点のxで上書きする(初期値は保険)
  e.vx = 0;
  e.vy = vySign * ENEMY_VY;
}

function initReaper(e, wave, memberIndex, gate) {
  // 前左/前右から斜めに流れて画面外へ抜ける(docs/enemies.md #3)。攻撃なし。滞在は他種より短い
  // (REAPER_VXが支配的で、y到達より先にx方向の画面外判定に掛かる設計。updateOneEnemy参照)。
  const { edgeY, edgeStep } = edgeParamsForGate(gate);
  const half = vHalfIndex(memberIndex);
  const sign = (memberIndex & 1) === 1 ? -1 : 1;
  e.x = waveBaseX + sign * half * REAPER_ENTRY_X_SPACING;
  e.y = edgeY + edgeStep * half * V_Y_STEP;
  e.vx = gate === GATES.FRONT_LEFT ? -REAPER_VX : REAPER_VX; // 出た側へさらに流れて速く抜ける
  e.vy = REAPER_VY;
  if (memberIndex === 0) {
    // 編隊の先頭メンバーがスポーンする瞬間に1回だけ、全滅ボーナス追跡を開始する。
    reaperTrackStart(currentFormationId, wave.count);
  }
}

function initGunwagon(e, wave, memberIndex, gate) {
  // 正面のみ(docs/enemies.md #5)。前方の縁から入り、GUNWAGON_TARGET_Yで居座って左右に滑る。
  // 降りてこない/退場条件はupdateOneEnemy側(moveGunwagon)で管理する。
  e.x = waveBaseX;
  e.y = f(-16);
  e.vx = rndRange(2) === 0 ? -GUNWAGON_SLIDE_VX : GUNWAGON_SLIDE_VX;
  e.vy = ENEMY_VY; // 定位置(GUNWAGON_TARGET_Y)に達するまでの入場降下速度
}

function initWheelsaw(e, wave, memberIndex, gate) {
  // 前左/前右から出て、左右の画面端で跳ね返りながら降下する(docs/enemies.md #13)。破壊不能。
  const { edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX;
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.vx = gate === GATES.FRONT_LEFT ? WHEELSAW_VX : -WHEELSAW_VX; // 中央方向へ動き出し、以後は端で反転
  e.vy = ENEMY_VY;
}

function initHopper(e, wave, memberIndex, gate) {
  // 前左/前右/正面(docs/enemies.md #4)。V字と同じ横広がりで重なりを避けつつ縦列で入場する。
  // 着地/滞空の状態機械はmoveHopperが毎フレーム管理する(flags=0からairborneで開始)。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX + vOffsetX(memberIndex);
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.vx = 0;
  e.vy = vySign * ENEMY_VY;
}

function initSandworm(e, wave, memberIndex, gate) {
  // 出現口を持たない(docs/enemies.md #6)。潜行状態(不可視・無敵・判定なし)でスポーンし、
  // 自機x付近を初期位置にする(以後updateSandwormPreが自機xへ寄せながら浮上位置を決める)。
  // SANDWORM_STAGGER_FRAMESでメンバーごとにtimerを負値にずらし、3体が同時に浮上しないようにする。
  e.x = curPlayerX + (memberIndex - 1) * SANDWORM_ENTRY_SPACING;
  e.y = SANDWORM_HOME_Y;
  e.vx = 0;
  e.vy = 0;
  e.flags |= SANDWORM_SUBMERGED_FLAG;
  e.timer = -(memberIndex * SANDWORM_STAGGER_FRAMES);
}

function initSidecar(e, wave, memberIndex, gate) {
  // 前左/前右のみ(docs/enemies.md #7)。縦列で入場し、moveSidecarが即座に左右往復を始める。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX;
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.anchorX = waveBaseX;
  e.vx = 0;
  e.vy = vySign * SIDECAR_VY;
}

function initMother(e, wave, memberIndex, gate) {
  // 正面のみ(docs/enemies.md #14)。前方の縁から入り、MOTHER_TARGET_Yで居座りに移る
  // (moveMother参照)。降りてこないガンワゴンと異なり、居座り後もゆっくり降下し続ける。
  e.x = waveBaseX;
  e.y = f(-16);
  e.vx = 0;
  e.vy = ENEMY_VY; // 定位置(MOTHER_TARGET_Y)までの入場降下速度
  e.anchorX = waveBaseX;
}

function initMirage(e, wave, memberIndex, gate) {
  // 後左/後右のみ(docs/enemies.md #8)。縦列で入場する(SIDECARと同形)。
  // 横方向はmoveMirageが毎フレーム自機の動きを反転して上書きする。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX;
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.vx = 0;
  e.vy = vySign * ENEMY_VY;
}

function initChaser(e, wave, memberIndex, gate) {
  // 後左/後右のみ(docs/enemies.md #9)。出現した側を基準に、自機のその側面へ回り込む
  // (BACK_LEFTから出た個体は自機の左側、BACK_RIGHTは右側へ寄る)。
  const { vySign, edgeY, edgeStep } = edgeParamsForGate(gate);
  e.x = waveBaseX + memberIndex * CHASER_ENTRY_SPACING;
  e.y = edgeY + edgeStep * memberIndex * COLUMN_Y_SPACING;
  e.vx = 0;
  e.vy = vySign * ENEMY_VY; // 初期値。次フレームからmoveChaserが上書きする
  if (gate === GATES.BACK_RIGHT) {
    e.flags |= CHASER_SIDE_RIGHT_FLAG;
  }
}

// kind→初期化関数のディスパッチテーブル(段階3の決定事項: if の羅列にしない)。
const ENEMY_INIT_BY_KIND = [
  initScatter,
  initDrifter,
  initReaper,
  initGunwagon,
  initWheelsaw,
  initHopper,
  initSandworm,
  initSidecar,
  initMother,
  initMirage,
  initChaser,
];

function initEnemyFromWave(e, wave, memberIndex, gate) {
  const kind = KIND_BY_FORMATION[wave.formation];
  e.kind = kind;
  e.tile = ENEMY_DEF_BY_KIND[kind].tile;
  e.hp = applyLoop(wave.hp, loop);
  e.flags = 0;
  e.atkTimer = FIRE_INTERVAL_BASE + rndRange(FIRE_INTERVAL_JITTER);
  e.formationId = currentFormationId;
  e.timer = 0;
  e.everOnscreen = false; // プール使い回し対策。スポーン直後は必ず未経験へ戻す
  e.fireCount = 0;
  e.leaveTimer = 0; // プール使い回し対策。前回生存時の経過フレームを持ち越さない
  e.leaving = false;
  // 発射しないkindはfireLimitを0のままにする(rndRangeでLFSRを無駄に1歩進めない。
  // ENEMY_CAN_FIRE_BY_KINDがfalseならどのみち攻撃パイプラインへ触れないため実害はないが、
  // 他のスポーン処理が使うLFSR系列をむやみにずらさない方を優先する)。
  e.fireLimit = ENEMY_CAN_FIRE_BY_KIND[kind]
    ? ENEMY_FIRE_LIMIT_MIN_BY_KIND[kind] + rndRange(ENEMY_FIRE_LIMIT_SPREAD_BY_KIND[kind])
    : 0;

  ENEMY_INIT_BY_KIND[kind](e, wave, memberIndex, gate);
}

// 現在セクションのwavesを順に、ウェーブ単位でスポーンする。
// 1ウェーブ=1種類・同一出現口・3〜5機。ウェーブを出しきったら90〜150フレーム(LFSR決定)の
// 空きを置き、その間は新規のスポーンを行わない。距離(distance)はセクション境界の判定にのみ使い、
// ウェーブの列自体はテーブルの並び順+フレームベースの空きだけで進む(決定論的)。
// スプライト予算/プール空きが足りない場合はcursorを進めずそのフレームは諦め、次フレームに再試行する
// （wave丸ごとスキップはしない。1体ずつ確保できた分だけ進める設計）。
function spawnPendingWave() {
  if (sectionIndex >= 2) {
    return;
  }
  const section = STAGES[curStageIndex].sections[sectionIndex];
  const waves = section.waves;

  while (waveCursor < waves.length) {
    const wave = waves[waveCursor];

    if (waveMemberIndex === 0) {
      if (waveGapTimer > 0) {
        waveGapTimer -= 1;
        return; // ウェーブ間の空き時間中。このフレームは何も湧かせない
      }
      currentGate = resolveGate(wave.gate);
      waveBaseX = f(GATE_X_MIN[currentGate] + rndRange(GATE_X_SPREAD[currentGate]));
      currentFormationId = nextFormationId;
      nextFormationId += 1;
    }

    while (waveMemberIndex < wave.count) {
      if (spriteBudgetLeft() < 4) {
        return; // 枠が足りない。cursorは進めずこのフレームはここで打ち切り、次フレームに再試行
      }
      const e = spawn(ENEMIES);
      if (!e) {
        return; // プール満杯。同様に次フレームへ持ち越す
      }
      initEnemyFromWave(e, wave, waveMemberIndex, currentGate);
      waveMemberIndex += 1;
    }

    // wave丸ごとスポーンし終えたので次のwaveへ。次wave開始前に90〜150フレームの空きを置く
    waveCursor += 1;
    waveMemberIndex = 0;
    waveGapTimer = WAVE_GAP_MIN + rndRange(WAVE_GAP_SPREAD);
  }
}

// --- kindごとの毎フレーム移動処理(ENEMY_MOVE_BY_KINDから呼ばれる) ---
// e.y(縦方向)は原則この後の共通コード(オフロード/減速スケール込みのvy積分)へ任せる。
// ここではkind固有の横移動・フェーズ遷移・退場トリガだけを行う。何もしないkindはmoveNoneを使う。

function moveNone() {}

function moveDrifter(e) {
  if (e.flags & DRIFTER_LEAVING_FLAG) {
    // 1発撃って離脱シーケンスに入った後は蛇行をやめる。xはそのまま(動かさない)、
    // yは共通コード(updateOneEnemyのvy積分)にまっすぐ任せて画面外(下)へ抜ける。
    return;
  }
  if ((e.flags & DRIFTER_TRANSITIONED_FLAG) === 0) {
    // 縦列フェーズ: xは動かさない(vx=0のまま)。中程を超えたら蛇行フェーズへ切り替える。
    if (e.y >= DRIFTER_SNAKE_START_Y) {
      e.flags |= DRIFTER_TRANSITIONED_FLAG;
      e.anchorX = e.x; // 切替時点のxを振動中心にする
      e.timer = 0;
    }
    return;
  }
  // 蛇行フェーズ(元KIND_SNAKEのロジックを流用)。折り返し(flipped)のたびに1回だけ
  // atkTimerを予備動作の先頭(TELEGRAPH_SLOWDOWN_FRAMES+1)へセットし、既存の減速→フラッシュ→発射
  // パイプラインへ乗せる(多重発火は起きない: flags&1が変化した回のみflippedがtrueになるため)。
  let step = SNAKE_STEP;
  if (e.atkTimer <= TELEGRAPH_SLOWDOWN_FRAMES) {
    step = fmul(step, TELEGRAPH_SLOWDOWN_NUM);
  }
  const dir = e.flags & 1;
  let flipped = false;
  if (dir === 0) {
    e.timer += step;
    if (e.timer >= SNAKE_AMPLITUDE) {
      e.flags |= 1;
      flipped = true;
    }
  } else {
    e.timer -= step;
    if (e.timer <= -SNAKE_AMPLITUDE) {
      e.flags &= ~1;
      flipped = true;
    }
  }
  e.x = e.anchorX + e.timer;
  if (flipped) {
    e.atkTimer = TELEGRAPH_SLOWDOWN_FRAMES + 1;
  }
}

function moveReaper(e) {
  e.x += e.vx; // 斜め軌道の横方向はここで積む(縦方向は共通コードのvy積分に任せる)
}

function moveGunwagon(e) {
  // 左右へ滑る(画面端でclampして反転)。降下中/居座り中/退場中いずれのフェーズでも横滑りは続ける。
  e.x += e.vx;
  if (e.x < GUNWAGON_MIN_X) {
    e.x = GUNWAGON_MIN_X;
    e.vx = -e.vx;
  } else if (e.x > GUNWAGON_MAX_X) {
    e.x = GUNWAGON_MAX_X;
    e.vx = -e.vx;
  }

  if ((e.flags & GUNWAGON_SETTLED_FLAG) === 0) {
    // 降下中。定位置(GUNWAGON_TARGET_Y)へ到達したらvyを0にして居座りフェーズへ入る。
    if (e.y >= GUNWAGON_TARGET_Y) {
      e.y = GUNWAGON_TARGET_Y;
      e.vy = 0;
      e.flags |= GUNWAGON_SETTLED_FLAG;
    }
  }
  // 居座り中(SETTLED済み・LEAVING前)はvy=0のまま何もしない。離脱(vyを負にして上へ抜ける)は
  // 2〜3回撃った時点でupdateOneEnemyの攻撃パイプラインからleaveGunwagon()が起動する。
}

function moveWheelsaw(e) {
  // 左右の画面端(スプライト半分を考慮したclamp範囲)で跳ね返りながら降下する。
  e.x += e.vx;
  if (e.x < WHEELSAW_MIN_X) {
    e.x = WHEELSAW_MIN_X;
    e.vx = -e.vx;
  } else if (e.x > WHEELSAW_MAX_X) {
    e.x = WHEELSAW_MAX_X;
    e.vx = -e.vx;
  }
}

function fireHopperBullet(e) {
  // 真下固定(狙わない)。docs/enemies.md #4「着地の硬直中に真下へ1発」。
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return;
  }
  const dir = DIR16[HOPPER_BULLET_DOWN_DIR];
  b.dirIdx = HOPPER_BULLET_DOWN_DIR;
  b.x = e.x + f(4);
  b.y = e.y + f(12);
  b.vx = fmul(dir.dx, f(ENEMY_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(ENEMY_BULLET_SPEED));
  b.tile = ENEMY_BULLET_TILE;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = 0;
}

function moveHopper(e) {
  // 跳ねながら降下し、着地の瞬間だけ完全停止する(その停止そのものが予備動作)。
  // 停止中(HOPPER_LANDED_FLAG)に1回だけ真下へ撃つ。fireLimitの共通atkTimerパイプラインは
  // 使わない(ENEMY_CAN_FIRE_BY_KIND[KIND_HOPPER]=false)ため、ここでfireCountを直接管理する。
  e.timer += 1;
  if ((e.flags & HOPPER_LANDED_FLAG) === 0) {
    if (e.timer >= HOPPER_AIR_FRAMES) {
      e.flags |= HOPPER_LANDED_FLAG;
      e.timer = 0;
      e.vy = 0; // 着地硬直: 完全停止
      if (e.fireCount < HOPPER_FIRE_LIMIT) {
        fireHopperBullet(e);
        e.fireCount += 1;
      }
    }
    return;
  }
  if (e.timer >= HOPPER_LAND_FRAMES) {
    e.flags &= ~HOPPER_LANDED_FLAG;
    e.timer = 0;
    e.vy = ENEMY_VY; // 次の跳躍へ
  }
}

function moveSidecar(e) {
  // 左右に大きく往復しながら降下する(docs/enemies.md #7)。1発撃って離脱シーケンスへ入ったら
  // (SIDECAR_LEAVING_FLAG)往復をやめ、まっすぐ画面外へ抜ける。振動ロジック自体はドリフターの
  // 蛇行フェーズと同形(timer+anchorXの往復)を流用する。
  if (e.flags & SIDECAR_LEAVING_FLAG) {
    return;
  }
  const dir = e.flags & 1;
  if (dir === 0) {
    e.timer += SIDECAR_STEP;
    if (e.timer >= SIDECAR_AMPLITUDE) {
      e.flags |= 1;
    }
  } else {
    e.timer -= SIDECAR_STEP;
    if (e.timer <= -SIDECAR_AMPLITUDE) {
      e.flags &= ~1;
    }
  }
  e.x = e.anchorX + e.timer;
}

function moveMother(e) {
  // 正面から入り、MOTHER_TARGET_Yへ達したら居座りに移る(ガンワゴンのSETTLEDと同形)。
  // ただしガンワゴンと違い居座り後も止まらず、ゆっくり降下し続けながら左右へ揺れる
  // (docs/enemies.md #14「ゆっくり降下しながら左右へ」)。射出上限に達すると
  // leaveMotherがLEAVING_FLAGを立て、以後は揺れを止めてまっすぐ上へ抜ける。
  if (e.flags & MOTHER_LEAVING_FLAG) {
    return;
  }
  if ((e.flags & MOTHER_SETTLED_FLAG) === 0) {
    if (e.y >= MOTHER_TARGET_Y) {
      e.y = MOTHER_TARGET_Y;
      e.vy = MOTHER_DRIFT_VY;
      e.flags |= MOTHER_SETTLED_FLAG;
      e.anchorX = e.x;
      e.timer = 0;
    }
    return;
  }
  const dir = e.flags & 1;
  if (dir === 0) {
    e.timer += MOTHER_SWAY_STEP;
    if (e.timer >= MOTHER_SWAY_AMPLITUDE) {
      e.flags |= 1;
    }
  } else {
    e.timer -= MOTHER_SWAY_STEP;
    if (e.timer <= -MOTHER_SWAY_AMPLITUDE) {
      e.flags &= ~1;
    }
  }
  e.x = e.anchorX + e.timer;
}

function moveMirage(e) {
  if (e.flags & MIRAGE_LEAVING_FLAG) {
    return; // 発射後は追従をやめる。e.vyは初期値のまま(上昇中)なので、そのまま素通りして抜ける
  }
  e.vx = -curPlayerVX; // 自機の左右の動きを反転して真似る
  e.x += e.vx;
  if (e.x < MIRAGE_MIN_X) {
    e.x = MIRAGE_MIN_X;
  } else if (e.x > MIRAGE_MAX_X) {
    e.x = MIRAGE_MAX_X;
  }
}

function moveChaser(e) {
  if (e.flags & CHASER_LEAVING_FLAG) {
    return; // 発射後はleaveChaserが設定したvx=0/vy=-ENEMY_VYのまま素通りして抜ける
  }
  const side = e.flags & CHASER_SIDE_RIGHT_FLAG ? 1 : -1;
  let targetX = curPlayerX + side * CHASER_SIDE_OFFSET_PX;
  if (targetX < CHASER_MIN_X) {
    targetX = CHASER_MIN_X;
  } else if (targetX > CHASER_MAX_X) {
    targetX = CHASER_MAX_X;
  }
  if (e.x < targetX) {
    e.x += CHASER_VX_SEEK;
    if (e.x > targetX) {
      e.x = targetX;
    }
  } else if (e.x > targetX) {
    e.x -= CHASER_VX_SEEK;
    if (e.x < targetX) {
      e.x = targetX;
    }
  }

  const dy = curPlayerY - e.y;
  const ady = dy < 0 ? -dy : dy;
  if (ady <= CHASER_ALIGN_DY_PX) {
    // 並走帯に入っている。自機の縦速度に合わせる(±CHASER_VY_MAXでcap)。
    let vy = curPlayerVY;
    if (vy > CHASER_VY_MAX) {
      vy = CHASER_VY_MAX;
    } else if (vy < -CHASER_VY_MAX) {
      vy = -CHASER_VY_MAX;
    }
    e.vy = vy;
    e.timer += 1;
    if (e.timer >= CHASER_ALIGN_FRAMES_REQUIRED && (e.flags & CHASER_PAIRED_FLAG) === 0) {
      // 並走成立の瞬間。ドリフターの折り返しトリガと同じ手筋でatkTimerを予備動作の先頭へ
      // 即座にセットし(通常の150±40フレーム周期を待たせない)、成立直後に横撃ちへつなげる。
      e.flags |= CHASER_PAIRED_FLAG;
      e.atkTimer = TELEGRAPH_SLOWDOWN_FRAMES + 1;
    }
  } else {
    e.timer = 0; // 帯を外れたら連続フレームカウンタをリセット(成立後はflagが立ったままなので影響しない)
    e.vy = dy < 0 ? -CHASER_VY_MAX : CHASER_VY_MAX;
  }
}

// kind→毎フレーム移動関数のディスパッチテーブル(段階3の決定事項: if の羅列にしない)。
// サンドワーム(KIND_SANDWORM)は潜行中updateOneEnemyの先頭で専用分岐(updateSandwormPre)へ
// バイパスされるため、ここではmoveNoneを割り当てる(浮上後は共通パイプラインへ合流し、
// 単に真下へ抜けるだけでよい=横移動不要)。
const ENEMY_MOVE_BY_KIND = [
  moveNone,
  moveDrifter,
  moveReaper,
  moveGunwagon,
  moveWheelsaw,
  moveHopper,
  moveNone,
  moveSidecar,
  moveMother,
  moveMirage,
  moveChaser,
];

// --- 発射上限到達時の離脱トリガ(kind別)。ENEMY_MOVE_BY_KINDと同じ並び順。 ---
// 呼ばれるのはfireEnemyBullet直後、fireCountがfireLimitに達した1フレームのみ(updateOneEnemy参照)。

function leaveDrifter(e) {
  // GUNWAGON_LEAVING_FLAGと同じパターンの一般化: フラグを立てて以後の蛇行を止め、
  // まっすぐ画面外(下)へ抜ける(vy自体はすでに正=前方出現の進行方向のまま、向きは変えない)。
  e.flags |= DRIFTER_LEAVING_FLAG;
}

function leaveGunwagon(e) {
  // 画面上部に居座っているため、退場は来た側(上)へ抜ける = vyを負にする。
  e.vy = -ENEMY_VY;
  e.flags |= GUNWAGON_LEAVING_FLAG;
}

function leaveSidecar(e) {
  // leaveDrifterと同形: 往復をやめ、まっすぐ画面外(下)へ抜ける。
  e.flags |= SIDECAR_LEAVING_FLAG;
}

function leaveMother(e) {
  // leaveGunwagonと同形: 居座っているため退場は来た側(上)へ抜ける。
  e.vy = -ENEMY_VY;
  e.flags |= MOTHER_LEAVING_FLAG;
}

function leaveMirage(e) {
  e.flags |= MIRAGE_LEAVING_FLAG;
}

function leaveChaser(e) {
  e.flags |= CHASER_LEAVING_FLAG;
  e.vx = 0;
  e.vy = -ENEMY_VY; // 来た側(上)へ抜ける
}

const ENEMY_LEAVE_BY_KIND = [
  leaveNone,
  leaveDrifter,
  leaveNone,
  leaveGunwagon,
  leaveNone,
  leaveNone,
  leaveNone,
  leaveSidecar,
  leaveMother,
  leaveMirage,
  leaveChaser,
];

// triggerLeave(e): 発射回数到達/時間切れどちらの経路からも呼ぶ共通の離脱トリガ。
// e.leavingを立ててから(二重トリガー防止)kind固有の離脱動作(ENEMY_LEAVE_BY_KIND)へ委譲する。
function triggerLeave(e) {
  e.leaving = true;
  ENEMY_LEAVE_BY_KIND[e.kind](e);
}

function updateOneEnemy(e) {
  // サンドワームの潜行中(SANDWORM_SUBMERGED_FLAG)は共通パイプライン(オフロード判定・vy積分・
  // 画面外消滅・発射)を一切通さず、専用の状態機械(updateSandwormPre)へ完全にバイパスする。
  // 「潜行中は無敵かつ判定なし」は、描画側(drawOneEnemy)とdamageEnemy/game.jsのisEnemyIntangible
  // 参照側で別途保証する(このバイパス自体はx/yの更新と浮上トリガのみを担当する)。
  if (e.kind === KIND_SANDWORM && (e.flags & SANDWORM_SUBMERGED_FLAG)) {
    updateSandwormPre(e);
    return;
  }

  // 被弾フラッシュの残フレーム消化
  if (e.flashTimer > 0) {
    e.flashTimer -= 1;
  }

  // spawnからの経過フレーム(時間ベース離脱バックストップ用の汎用カウンタ)。
  // サンドワーム潜行中はこの関数自体に到達しない(冒頭のバイパスで早期returnするため、
  // その間はカウントされない=問題ない。ENEMY_LEAVE_TIME_LIMIT_BY_KINDを使わない種のため)。
  e.leaveTimer += 1;

  ENEMY_MOVE_BY_KIND[e.kind](e);

  // オフロード判定はplayerと同じ規則: 足元(下端, +16)の行をサンプルする。
  const centerPx = toPx(e.x) + 8;
  e.offRoad = isOffRoadAt(curScrollY, centerPx, toPx(e.y) + 16);

  // e.vy自体は生成時定数のまま書き換えない場合が多いが、ガンワゴンは居座り/退場の状態遷移で
  // vyそのものを書き換える(0→負)設計のため、ここでは「その時点のe.vy」を使うのが正しい。
  // 決定事項: ドリフター蛇行フェーズの横方向(timerベース)は複雑化を避けて非スケール対象のままとし、
  // 「移動速度2/3」・「自機死亡演出中のスクロール速度比」は支配的な縦方向の進行(vy)にのみ適用する。
  let scaledVy = fmul(e.vy, curEnemySpeedRatio); // 自機死亡演出中〜復活の間、世界全体を一緒にスローにする
  if (e.atkTimer <= TELEGRAPH_SLOWDOWN_FRAMES) {
    scaledVy = fmul(scaledVy, TELEGRAPH_SLOWDOWN_NUM);
  }
  const vy = e.offRoad ? fmul(scaledVy, ENEMY_SPEED_OFFROAD_NUM) : scaledVy;
  e.y += vy;

  // 一度も画面内に入ったことがない個体(スポーン直後、画面外の入場待機位置)は画面外消滅判定の
  // 対象にしない。ここで一度入ったことを記録できたときだけ、以下の消滅判定を以後有効にする
  // (「一度画面内に入った個体が完全に外へ出たら消す」。docs/enemies.md「雑魚敵は一撃離脱」節)。
  if (!e.everOnscreen) {
    if (
      toPx(e.x) > ONSCREEN_X_MIN_PX &&
      toPx(e.x) < ONSCREEN_X_MAX_PX &&
      toPx(e.y) > ONSCREEN_Y_MIN_PX &&
      toPx(e.y) < ONSCREEN_Y_MAX_PX
    ) {
      e.everOnscreen = true;
    }
  }

  // e.vy(現在値)の符号で進行方向を見る。前方出現かつ下降中(vy>=0)は下端を抜けたら消え、
  // 上方向へ抜ける途中(vy<0。ガンワゴンの退場、または将来の背後出現)は上端を抜けたら消える。
  // 逆側の判定を入れると、縦列/蛇行の後続メンバーが画面外の入場待機位置(まだ側)にいるだけで
  // 誤って消えてしまうため、進行方向側のみ見る。everOnscreenでさらに「まだ一度も入っていない」
  // 個体を除外し、スポーン直後の全滅を防ぐ。
  if (e.everOnscreen) {
    if (e.vy >= 0) {
      if (toPx(e.y) > 160) {
        if (e.kind === KIND_REAPER) {
          reaperTrackOnEscape(e.formationId);
        }
        e.alive = false;
        return;
      }
      // リーパーのみ、x方向の画面外もチェックする(vxが支配的な斜め軌道で、y到達より先に
      // 左右へ抜けるのが正しい滞在時間の短さになるため)。他kindはx方向が常に画面内に収まる
      // 設計(V字のclamp/ガンワゴン・ホイールソーのclamp)なので、ここで判定すると誤爆する。
      if (e.kind === KIND_REAPER && (toPx(e.x) < REAPER_X_EXIT_MIN_PX || toPx(e.x) > REAPER_X_EXIT_MAX_PX)) {
        reaperTrackOnEscape(e.formationId);
        e.alive = false;
        return;
      }
    } else if (toPx(e.y) < -16) {
      e.alive = false;
      return;
    }
  }

  // 発射しないkind(スキャッター/リーパー/ホイールソー)はここで打ち切り、atkTimerに一切触れない
  // (触れ続けるといつか0に達して誤発射するため。ENEMY_CAN_FIRE_BY_KIND参照)。
  if (!ENEMY_CAN_FIRE_BY_KIND[e.kind]) {
    return;
  }

  // 死亡演出中(curSpawnFrozen)は発射予備動作ごと完全に停止する（構え点滅も進まない）。
  // 発射予備動作つきの攻撃サイクル。先に減速し、TELEGRAPH_FRAMES以下になると描画側がpalInvertを点滅させる。
  // atkTimerがTELEGRAPH_FRAMES以下に達するまでは絶対に発射しないので、予備動作なしで撃つ敵は存在しない。
  if (curSpawnFrozen) {
    return;
  }
  // 時間ベース離脱バックストップ(docs/spec.md「自機の可動範囲」節の注意書き参照)。
  // 至近距離での近距離発射抑止により発射回数側の離脱条件が永久に成立しない個体を、
  // 発射回数を待たずここで強制的に離脱させる。発射回数側の早期returnより先に判定することで、
  // 「発射回数か経過時間の早い方で離脱」を素直に実現する(通常プレイでは発射回数側が先に
  // 成立するため、ここは至近距離張り付き時のみ効くバックストップになる)。
  if (e.fireLimit > 0 && !e.leaving && ENEMY_LEAVE_TIME_LIMIT_BY_KIND[e.kind] > 0 && e.leaveTimer >= ENEMY_LEAVE_TIME_LIMIT_BY_KIND[e.kind]) {
    triggerLeave(e);
    return;
  }
  // 雑魚敵は一撃離脱: 発射上限(fireLimit)に達した個体は、以後この攻撃パイプラインへ一切触れない
  // (leaveXxx()が既にkind固有の離脱動作へ切り替え済み。ここで毎フレーム再トリガする必要はない)。
  if (e.fireLimit > 0 && e.fireCount >= e.fireLimit) {
    return;
  }
  // 予備動作へ入る手前で、自機が近いあいだ、または並走未成立(CHASER)のあいだはカウントダウンごと止める。
  // 減速帯へ入れてしまうと「撃てないのに這って遅い」敵になる(実測でこの状態が敵サンプルの
  // 46%を占めていた)。帯の外で止めておけば通常速度のまま近接でき、自機が離れてから
  // 改めて予備動作を踏む。
  const fireBlocked = isPlayerTooCloseToFire(e) || ENEMY_FIRE_BLOCK_BY_KIND[e.kind](e);
  if (e.atkTimer > TELEGRAPH_SLOWDOWN_FRAMES || !fireBlocked) {
    e.atkTimer -= 1;
  }
  if (e.atkTimer <= 0) {
    if (isPlayerTooCloseToFire(e) || ENEMY_FIRE_BLOCK_BY_KIND[e.kind](e)) {
      // 至近距離の回避不能弾を作らないため、または並走未成立のため、攻撃をキャンセルせず待機させる。範囲内では絶対にspawnしない。
      // 待機位置を予備動作帯の「1つ外側」に置くのが要点。ここを1にすると待機中ずっと減速帯に
      // 居座り、自機が近いあいだ敵が這うように遅くなる(実測: 敵サンプルの46%がこの状態だった)。
      // 帯の外で待たせれば通常速度のまま近接でき、自機が離れたあとは改めて64フレームの
      // 予備動作を踏んでから撃つ(予備動作なしで撃つ敵は存在しない、という保証も保たれる)。
      e.atkTimer = TELEGRAPH_SLOWDOWN_FRAMES + 1;
      return;
    }
    ENEMY_FIRE_ACTION_BY_KIND[e.kind](e);
    e.fireCount += 1;
    if (e.fireLimit > 0 && e.fireCount >= e.fireLimit) {
      // 一撃離脱の上限に到達。まず減速状態(TELEGRAPH_SLOWDOWN_NUM)を解除してから
      // (でないと離脱中もずっと1/4速のまま這うことになる)、kind固有の離脱動作へ切り替える。
      e.atkTimer = TELEGRAPH_SLOWDOWN_FRAMES + 1;
      triggerLeave(e);
    } else {
      // ドリフターは折り返し(moveDrifter)がatkTimerを直接上書きして再トリガーするため、ここでの
      // 周期リセットは実質「折り返しが来るまでの保険値」になる。ガンワゴンはこの周期でそのまま撃ち続ける。
      e.atkTimer = FIRE_INTERVAL_BASE + rndRange(FIRE_INTERVAL_JITTER);
    }
  }
}

function noFireBlock() {
  return false;
}

function chaserFireBlocked(e) {
  return (e.flags & CHASER_PAIRED_FLAG) === 0;
}

// kind→追加の発射禁止条件(段階3グループ3の決定事項)。既存のisPlayerTooCloseToFireと同じ
// 「攻撃サイクル自体はキャンセルせず待機させる」扱いにするための拡張ポイント。
// デフォルトはnoFireBlock(常にfalse=禁止条件なし)。CHASERのみ「並走成立前は撃たない」を実装する。
const ENEMY_FIRE_BLOCK_BY_KIND = [
  noFireBlock, noFireBlock, noFireBlock, noFireBlock, noFireBlock,
  noFireBlock, noFireBlock, noFireBlock, noFireBlock,
  noFireBlock, // MIRAGE
  chaserFireBlocked, // CHASER
];

function isPlayerTooCloseToFire(e) {
  let dx = curPlayerX + SPRITE_CENTER_OFFSET - (e.x + SPRITE_CENTER_OFFSET);
  let dy = curPlayerY + SPRITE_CENTER_OFFSET - (e.y + SPRITE_CENTER_OFFSET);
  if (dx < 0) {
    dx = -dx;
  }
  if (dy < 0) {
    dy = -dy;
  }
  return dx <= ENEMY_FIRE_PROXIMITY && dy <= ENEMY_FIRE_PROXIMITY;
}

function fireEnemyBullet(e) {
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return;
  }

  // 段階3の決定事項: ENEMY_BULLET_FIXED_DIR(旧COLUMN専用の固定下方向)は使わず、全kindがaim16で
  // 自機を狙う(ドリフター/ガンワゴンともに16方向の狙い撃ち。spec:「全種aim16でよい」)。
  const dirIdx = aim16(curPlayerX - e.x, curPlayerY - e.y);
  const dir = DIR16[dirIdx];

  b.dirIdx = dirIdx;
  b.x = e.x + f(4);
  b.y = e.y + f(12);
  b.vx = fmul(dir.dx, f(ENEMY_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(ENEMY_BULLET_SPEED));
  b.tile = ENEMY_BULLET_TILE;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = 0;
}

// サイドカー専用の発射アクション: 自機の「移動先」(現在位置+推定速度×SIDECAR_LEAD_FRAMES)を
// aim16で狙い、DIR16の初速から上向きに少し多めの初速(SIDECAR_LOB_ARC_BOOST)を引いて発射する。
// 以後は毎フレームSIDECAR_LOB_GRAVITYで重力を加算する(updateOneEnemyBullet参照)ことで
// 山なりの弧を描かせる。三角関数は使わず、既存のaim16/DIR16の範囲だけで方向を決める。
function fireSidecarLob(e) {
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return;
  }
  const leadX = curPlayerX + curPlayerVX * SIDECAR_LEAD_FRAMES;
  const leadY = curPlayerY + curPlayerVY * SIDECAR_LEAD_FRAMES;
  const dirIdx = aim16(leadX - e.x, leadY - e.y);
  const dir = DIR16[dirIdx];

  b.dirIdx = dirIdx;
  b.x = e.x + f(4);
  b.y = e.y + f(12);
  b.vx = fmul(dir.dx, f(SIDECAR_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(SIDECAR_BULLET_SPEED)) - SIDECAR_LOB_ARC_BOOST;
  b.tile = ENEMY_BULLET_TILE; // 専用弾タイルは作らない(スプライト40枚上限を守るため既存の敵弾タイルを流用)
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = ENEMY_BULLET_KIND_LOB; // 重力を受ける特殊弾種別(updateOneEnemyBullet参照)
}

// マザー専用の発射アクション: 弾ではなくスキャッターを1体射出する(docs/enemies.md #14
// 「ハッチからスキャッターを連続射出」)。射出されたスキャッターはENEMIESプールを1枠食うため、
// スプライト枠が逼迫している場合は今回のサイクル分を諦める(fireCountは呼び出し元でどのみち
// +1されるので、一撃離脱と同じく「機会を1回消費するが実際には出ないことがある」扱いにする。
// fireEnemyBulletのプール満杯時と同じ寛容な劣化)。
function fireMotherScatter(e) {
  if (spriteBudgetLeft() < 4) {
    return;
  }
  const c = spawn(ENEMIES);
  if (!c) {
    return;
  }
  c.kind = KIND_SCATTER;
  c.tile = ENEMY_DEF_BY_KIND[KIND_SCATTER].tile;
  c.hp = applyLoop(MOTHER_CHILD_HP, loop);
  c.flags = 0;
  c.atkTimer = 0; // スキャッターは発射しない種
  c.formationId = e.formationId; // マザー自身の編隊IDを流用(専用トラッキングは持たない)
  c.timer = 0;
  c.everOnscreen = false; // 通常spawnと同じく、共通パイプラインの初回判定に任せる
  c.fireCount = 0;
  c.fireLimit = 0;
  c.leaveTimer = 0; // fireLimit=0(この個体は時間ベース離脱を使わない)なので実害はないが、
  c.leaving = false; // プール使い回し時に前回生存分の値を持ち越さないよう念のため揃えておく。
  c.flashTimer = 0; // プール使い回し対策(initEnemyFromWaveと違い個別フィールドを手で設定するため明示する)
  c.x = e.x;
  c.y = e.y + f(8); // 後部ハッチ(下寄り)から出す見た目
  c.vx = 0;
  c.vy = ENEMY_VY; // 標準のスキャッター降下速度で真下へ抜けさせる
}

// kind→発射アクションのディスパッチテーブル(段階3グループ2の決定事項)。使われないkind
// (ENEMY_CAN_FIRE_BY_KINDがfalseのkind)はどれを入れても実害がないため、既定でfireEnemyBulletを
// 埋めておき、実際に狙い弾を撃つDRIFTER/GUNWAGONもそのままこの既定値を使う。
const ENEMY_FIRE_ACTION_BY_KIND = [
  fireEnemyBullet,
  fireEnemyBullet, // DRIFTER
  fireEnemyBullet,
  fireEnemyBullet, // GUNWAGON
  fireEnemyBullet,
  fireEnemyBullet,
  fireEnemyBullet,
  fireSidecarLob, // SIDECAR
  fireMotherScatter, // MOTHER
  fireEnemyBullet, // MIRAGE
  fireEnemyBullet, // CHASER
];

// --- サンドワーム専用: 潜行(不可視・無敵・判定なし)→予告(砂煙)→浮上して放射3発 ---

// 砂煙の警告演出。「既存の描画手段(SMOKE)だけを使い、新しい描画インタフェースを増やさない」
// (docs/enemies.md #6の注記)ため、game.js側が既に持つオフロード煙プール(SMOKE)をそのまま
// 間借りする。ageSmoke/drawSmoke(game.js)は誰が生成したかを問わず動くので、enemies.js側からの
// spawnだけで警告表現が成立する。vy=0にして「盛り上がる」その場のポップ演出にする
// (自機オフロード煙のように流れ落とさない)。
function spawnSandwormSmoke(x, y) {
  const s = spawn(SMOKE);
  if (!s) {
    return;
  }
  s.x = x;
  s.y = y;
  s.vy = 0;
  s.timer = 0;
  s.tile = TILE_SMOKE;
}

// 浮上後の放射3発。中心方向(自機狙い)を軸に、DIR16の16方向を約±112.5度ずつずらした3方向へ
// 均等に近い形で撃つ(5,5,6ステップ=112.5°/112.5°/135°の分割。三角関数は使わずDIR16の
// インデックス演算だけで表現する)。
function fireSandwormBulletAt(e, dirIdx) {
  const b = spawn(ENEMY_BULLETS);
  if (!b) {
    return;
  }
  const dir = DIR16[dirIdx];
  b.dirIdx = dirIdx;
  b.x = e.x + f(4);
  b.y = e.y + f(4);
  b.vx = fmul(dir.dx, f(ENEMY_BULLET_SPEED));
  b.vy = fmul(dir.dy, f(ENEMY_BULLET_SPEED));
  b.tile = ENEMY_BULLET_TILE;
  b.hp = 1;
  b.flags = 0;
  b.timer = 0;
  b.kind = 0;
}

function fireSandwormBurst(e) {
  const baseDir = aim16(curPlayerX - e.x, curPlayerY - e.y);
  fireSandwormBulletAt(e, baseDir);
  fireSandwormBulletAt(e, (baseDir + 5) % 16);
  fireSandwormBulletAt(e, (baseDir + 11) % 16);
}

// updateOneEnemyから潜行中に限りバイパスされる専用の状態機械。e.timerをフェーズ内フレーム
// カウンタとして専有する(他kindのtimer用途とは独立。サンドワームは共通パイプラインの
// vy積分・オフロード・画面外消滅に一切触れないため衝突しない)。
// フェーズ: (負のtimer=編隊内スタッガー待ち) → 潜行接近(HOMING) → 予告(TELEGRAPH、砂煙) → 浮上。
function updateSandwormPre(e) {
  e.timer += 1;
  if (e.timer <= 0) {
    return; // 編隊内の出現ずらし待ち。まだ何もしない(不可視のまま)
  }
  if (e.timer <= SANDWORM_HOMING_FRAMES) {
    // 潜行接近: 不可視・無敵・判定なしのまま自機xへゆっくり寄る
    if (e.x < curPlayerX) {
      e.x += SANDWORM_HOMING_VX;
      if (e.x > curPlayerX) {
        e.x = curPlayerX;
      }
    } else if (e.x > curPlayerX) {
      e.x -= SANDWORM_HOMING_VX;
      if (e.x < curPlayerX) {
        e.x = curPlayerX;
      }
    }
    return;
  }

  const telegraphElapsed = e.timer - SANDWORM_HOMING_FRAMES;
  if (telegraphElapsed === 1) {
    e.anchorX = e.x; // 浮上位置をこの時点のxで確定する(以後x/yは動かさない)
  }
  if (telegraphElapsed <= SANDWORM_TELEGRAPH_FRAMES) {
    // 砂煙が盛り上がる予告(唯一の警告)。SANDWORM_SMOKE_INTERVALごとに1個吹く。
    if (telegraphElapsed % SANDWORM_SMOKE_INTERVAL === 1) {
      spawnSandwormSmoke(e.anchorX, e.y);
    }
    return;
  }

  // 浮上: 以後は共通パイプラインへ合流させる(moveNoneでvy積分に任せ、まっすぐ下へ抜けさせる)。
  e.flags &= ~SANDWORM_SUBMERGED_FLAG;
  e.x = e.anchorX;
  e.vy = ENEMY_VY;
  fireSandwormBurst(e);
}

// game.js側の当たり判定(自機接触/自弾ヒット)が「潜行中は判定なし」を守るための公開判定。
// 該当しないkind/状態では常にfalseを返す(既存の他kindの挙動には一切影響しない)。
export function isEnemyIntangible(e) {
  return e.kind === KIND_SANDWORM && (e.flags & SANDWORM_SUBMERGED_FLAG) !== 0;
}

// sectionIndex>=2 は STAGES[curStageIndex].sections の boss セクション(index2)に到達済みという意味。
// game.js はこれを見てボス戦への遷移トリガに使う。
// 進行の途中(セクション/ウェーブ)から開始する。検証・確認用の通常API。
// スポーン順そのものは変えず、開始位置だけを進める。URLの解釈やデバッグ用の
// 入口はここには置かない(src/debug.js が持ち、ブラウザ単体版からしか読まれない)。
// stageIdx(第3引数、省略可): 段階3グループ2(ホッパー/サンドワーム/サイドカー/マザー)を
// STAGES[1](ジャングル)の定義から検証するための追加パラメータ。省略時は0(荒野=通常のM1プレイ対象)
// のままなので、既存の呼び出し(game.startPlayAt(section, wave, invuln))は一切挙動が変わらない。
export function startAtWave(sectionIdx, waveIdx, stageIdx) {
  let sti = stageIdx | 0;
  if (sti < 0 || sti >= STAGES.length || STAGES[sti].sections.length === 0) {
    sti = 0;
  }
  curStageIndex = sti;

  let si = sectionIdx | 0;
  if (si < 0) {
    si = 0;
  }
  if (si > 1) {
    si = 1;
  }
  const waves = STAGES[curStageIndex].sections[si].waves;
  let wi = waveIdx | 0;
  if (wi < 0) {
    wi = 0;
  }
  if (wi >= waves.length) {
    wi = waves.length - 1;
  }
  sectionIndex = si;
  waveCursor = wi;
  waveMemberIndex = 0;
  waveGapTimer = 0;
  // 開始位置を進めた時点を、そのセクションの起点として扱う(distanceは0から進む)。
  sectionStartDistance = 0;
}

export function isAtBossSection() {
  return sectionIndex >= 2;
}

// デバッグ観測用(window.__bagulas)。読み取り専用の公開で、ロジックからの逆参照はない。
export function getSectionIndex() {
  return sectionIndex;
}

// ボス戦突入時などにゾコ敵を一括撃破せず即消去する（スプライト/スキャンライン枠をボス用に空ける）。
export function clearEnemies() {
  forEach(ENEMIES, killSlot);
}

// speedRatio: 8.8固定小数点(256=等倍)。自機死亡演出〜復活の間、game.jsの現在スクロール速度から
// 算出して渡される（通常時は常に256=等速）。spawnFrozen: 死亡演出中はtrueになり、スポーン/発射を止める。
export function updateEnemies(distance, playerX, playerY, scrollY, speedRatio, spawnFrozen) {
  // サイドカーの「移動先を狙う」に使う自機速度の推定(前フレームとの差分)。resetEnemies直後の
  // 最初の1フレームだけは差分を取らず0にする(playerVelocityPrimedがfalseの間)。
  if (playerVelocityPrimed) {
    curPlayerVX = playerX - prevPlayerX;
    curPlayerVY = playerY - prevPlayerY;
  } else {
    curPlayerVX = 0;
    curPlayerVY = 0;
    playerVelocityPrimed = true;
  }
  prevPlayerX = playerX;
  prevPlayerY = playerY;
  curPlayerX = playerX;
  curPlayerY = playerY;
  curScrollY = scrollY;
  curDistance = distance;
  curEnemySpeedRatio = speedRatio;
  curSpawnFrozen = spawnFrozen;
  if (!spawnFrozen) {
    advanceSection(distance);
    spawnPendingWave();
  }
  forEach(ENEMIES, updateOneEnemy);
}

function isBulletOffscreen(b) {
  const px = toPx(b.x);
  const py = toPx(b.y);
  return px < -16 || px > 160 || py < -16 || py > 144;
}

function updateOneEnemyBullet(b) {
  if (b.kind === ENEMY_BULLET_KIND_LOB) {
    // サイドカーの山なり弾のみ、weapons.jsのDYNAMITE_GRAVITYと同系統の重力を毎フレーム加算する
    // (初速はfireSidecarLobで上向きに多めに設定済み。他の敵弾はkind=0のまま直進する)。
    b.vy += SIDECAR_LOB_GRAVITY;
  }
  b.x += b.vx;
  b.y += b.vy;
  if (isBulletOffscreen(b)) {
    b.alive = false;
  }
}

export function updateEnemyBullets() {
  forEach(ENEMY_BULLETS, updateOneEnemyBullet);
}

// 決定事項: stages.jsのod.xはあくまで「希望x」。新構造では画面全面が基本オンロードで、
// オフロードは左右からせいぜいMAX_OFFROAD_EACH列しか張り出さないため、gfx.jsが公開する
// SAFE_ONROAD_LEFT_PX..SAFE_ONROAD_RIGHT_PXの帯は常にオンロードであることが構造的に保証される。
// 障害物幅16pxがその帯からはみ出さないようclampするだけでよく、行ごとのscrollY参照は不要になった。
function computeObstacleX(preferredX) {
  let x = preferredX;
  if (x < SAFE_ONROAD_LEFT_PX) {
    x = SAFE_ONROAD_LEFT_PX;
  }
  const maxX = SAFE_ONROAD_RIGHT_PX - 16; // 障害物幅16pxが帯の右端にかからない上限
  if (x > maxX) {
    x = maxX;
  }
  return x;
}

function initObstacle(o, od) {
  o.x = f(computeObstacleX(od.x));
  o.y = f(-16);
  o.vx = 0;
  o.vy = 0; // 実際の下降量は毎フレームcurObstacleVy(=現在のスクロール速度)を使う。詳細はupdateOneObstacle参照
  o.timer = 0;
  o.kind = 0;

  if (od.kind === OBSTACLE_KINDS.ROCK.id) {
    o.tile = TILE16_ROCK;
    o.hp = OBSTACLE_HP;
    o.flags = 1; // destructible
  } else if (od.kind === OBSTACLE_KINDS.CACTUS.id) {
    o.tile = TILE16_CACTUS;
    o.hp = OBSTACLE_HP;
    o.flags = 1; // destructible
  } else {
    // FENCE
    o.tile = TILE16_FENCE;
    o.hp = 0;
    o.flags = 0; // 破壊不可
  }
}

// stage1Mainのobstaclesのみを対象にする。prelude/bossのobstacles配列は空なので自然に何も起きないが、
// セクションindexでも明示的にmainのみへ限定しておく（前提を崩さないため）。
function spawnPendingObstacles(distance) {
  if (sectionIndex !== 1) {
    return;
  }
  const section = STAGES[curStageIndex].sections[1];
  const obstacles = section.obstacles;
  const localDistance = distance - sectionStartDistance;

  while (obstacleCursor < obstacles.length && obstacles[obstacleCursor].at <= localDistance) {
    const od = obstacles[obstacleCursor];
    const o = spawn(OBSTACLES);
    if (!o) {
      return; // プール満杯。cursorを進めず次フレームに再試行
    }
    initObstacle(o, od);
    obstacleCursor += 1;
  }
}

function updateOneObstacle(o) {
  o.y += curObstacleVy; // 現在のスクロール速度そのもの。止まれば障害物も止まる
  if (toPx(o.y) > 160) {
    o.alive = false;
  }
}

// scrollSpeed: game.js側の現在のスクロール速度(8.8固定小数点)。障害物はこれに完全追従する。
export function updateObstacles(distance, scrollSpeed) {
  advanceSection(distance);
  spawnPendingObstacles(distance);
  curObstacleVy = scrollSpeed;
  forEach(OBSTACLES, updateOneObstacle);
}

function drawOneEnemy(e) {
  if (isEnemyIntangible(e)) {
    return; // サンドワーム潜行中(無敵・判定なし)は不可視。唯一の警告は砂煙(SMOKE)側で出す
  }
  let palInvert = false;
  if (e.flashTimer > 0) {
    palInvert = true;
  } else if (e.atkTimer <= TELEGRAPH_FRAMES) {
    // 発射TELEGRAPH_FRAMES前から4フレーム周期でpalInvertを切り替えて構えモーションを表現する
    palInvert = ((e.atkTimer >> TELEGRAPH_BLINK_SHIFT) & 1) === 0;
  }
  // オフロード時の上下1pxガタガタ揺れ（描画のみ。e.y自体は変更しないので当たり判定に影響しない）。
  // 周期をSHAKE_PERIOD_SHIFT分伸ばして控えめにする(game.jsのplayer側と同じ考え方)。
  const shakeY = e.offRoad ? (((curDistance >> SHAKE_PERIOD_SHIFT) & 1) ? -1 : 1) : 0;
  if (pushMeta16(toPx(e.x), toPx(e.y) + shakeY, e.tile, 0, palInvert)) {
    e.lastDrawnFrame = curDistance;
  }
}

// 優先度3(自機・敵弾に次ぐ)。枠が足りない時のために、毎フレーム開始位置をcurDistance基準で
// ずらして巡回する(forEachFrom)。同じ個体だけが永久に描かれない状態を避ける(実機ちらつき相当)。
export function drawEnemies() {
  forEachFrom(ENEMIES, curDistance, drawOneEnemy);
}

function drawOneEnemyBullet(b) {
  if (pushSprite(toPx(b.x), toPx(b.y), b.tile, 0)) {
    b.lastDrawnFrame = curDistance;
  }
}

// 優先度2(自機に次いで最優先で残す)。理不尽な被弾を避けるため、枠が足りなくても
// 巡回順で全弾が交互に表示される(forEachFrom)。
export function drawEnemyBullets() {
  forEachFrom(ENEMY_BULLETS, curDistance, drawOneEnemyBullet);
}

function drawOneObstacle(o) {
  drawBGObject(toPx(o.x), toPx(o.y), o.tile);
}

export function drawObstacles() {
  forEach(OBSTACLES, drawOneObstacle);
}

function spawnEnemyExplosion(x, y) {
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = x;
  eff.y = y;
  eff.vx = 0;
  eff.vy = 0;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_ENEMY_EXPLOSION;
  eff.tile = ENEMY_EXPLOSION_TILES[0];
  eff.radius = 0;
}

function spawnOneDebris(x, y, vx, vy) {
  const eff = spawn(EFFECTS);
  if (!eff) {
    return;
  }
  eff.x = x;
  eff.y = y;
  eff.vx = vx;
  eff.vy = vy;
  eff.hp = 0;
  eff.flags = 0;
  eff.timer = 0;
  eff.kind = EFFECT_KIND_DEBRIS;
  eff.tile = 1;
  eff.radius = 0;
}

// damageEnemy(e, dmg): ダメージを与え、撃破時は爆発/破片を発生させ、
// game.js側で score に加算すべき値を返す（撃破しなければ0を返す）。
export function damageEnemy(e, dmg) {
  // ホイールソー: 破壊不能(docs/enemies.md #13)。hp減算・爆発・スコア・被弾フラッシュを一切
  // 発生させずに0を返す(不可壊なのでダメージ演出を出さない)。弾の消費/貫通挙動はこの関数を呼ぶ
  // checkOneEnemyAgainstCurBullet(game.js)側の既存ロジックにそのまま任せる(この関数は変更不要)。
  // 非pierce弾はヒットで消え、鉄球(pierce)は既存通り貫通する — それが「弾は消す/貫通どちらでも
  // よい」という要件を自然に満たす。
  if (e.kind === KIND_WHEELSAW) {
    return 0;
  }
  // サンドワーム潜行中: 無敵(docs/enemies.md #6)。hp減算・爆発・スコア・被弾フラッシュを
  // 一切発生させない。ホイールソーと違い恒常的な無敵ではないため、fireSandwormBurstで
  // SANDWORM_SUBMERGED_FLAGが落ちた(=浮上した)後は通常どおりダメージを受ける。
  if (isEnemyIntangible(e)) {
    return 0;
  }
  e.hp -= dmg;
  e.flashTimer = HIT_FLASH_FRAMES;
  if (e.hp <= 0) {
    e.alive = false;
    spawnEnemyExplosion(e.x, e.y);
    spawnOneDebris(e.x, e.y, -f(1), -f(1));
    spawnOneDebris(e.x, e.y, f(1), -f(1));
    let value = ENEMY_SCORE_VALUE;
    if (e.kind === KIND_REAPER && reaperTrackOnKill(e.formationId)) {
      // 同一編隊5機を「抜けきる前に全滅」させた瞬間。全滅ボーナスを撃破スコアに合算する。
      value += REAPER_ALLKILL_BONUS;
    }
    return value;
  }
  return 0;
}

// damageObstacle(o, dmg): 破壊不可(FENCE)は何もせず0を返す。破壊可はhpを減らし、
// 破壊時は爆発を発生させ加算すべきスコアを返す。
export function damageObstacle(o, dmg) {
  if ((o.flags & 1) === 0) {
    return 0;
  }
  o.hp -= dmg;
  if (o.hp <= 0) {
    o.alive = false;
    spawnEnemyExplosion(o.x, o.y);
    return OBSTACLE_SCORE_VALUE;
  }
  return 0;
}
