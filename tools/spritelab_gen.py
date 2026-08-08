#!/usr/bin/env python3
"""SpriteLab で BAGULAS (DMG 風トップダウン・レース/シューター) の
スプライト素材を生成する。

  python3 tools/spritelab_gen.py --list
  python3 tools/spritelab_gen.py --only player_buggy --dry-run
  python3 tools/spritelab_gen.py --all --dry-run
  python3 tools/spritelab_gen.py --all
  python3 tools/spritelab_gen.py --missing

プロンプトは art/prompts/<id>.txt に 1 アセット 1 ファイルで置く
(style_notes.txt だけは共有スタイル文で、アセットではないので対象から除外する)。
これが正のソースであり、生成のたびに揺れないようにする。

API キーは環境変数 SPRITELAB_API_KEY からのみ読む。
ドットファイルは読まない。CLI 引数として渡すことはできない。
キーの値そのものを print/log することは絶対にしない。

--dry-run はプロンプト・style_notes・全パラメータを表示するだけで、
ネットワークには一切触れない (urllib.request.urlopen を呼ぶコードパスへ
到達する前に return する)。
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
ART = os.path.join(ROOT, "art")
PROMPT_DIR = os.path.join(ART, "prompts")
RAW_DIR = os.path.join(ART, "raw")
GENERATED_DIR = os.path.join(ART, "generated")
API = "https://spritelab.dev/api/v1/backgrounds"

STYLE_NOTES_FILE = "style_notes.txt"

# BAGULAS は 16x16 のキャラクター / 8x8 or 16x16 の障害物・地形タイルへ
# 縮小することが前提。生成元の解像度は縮小時にきれいに落ちるよう、
# 最終ピクセルサイズの整数倍 (pixel_scale) で発注する。
DEFAULTS = {
    "quality": "standard",
    "width": 512,
    "height": 512,
    "pixel_scale": 32,   # 512 / 32 = 16px 相当の元絵
    "max_colours": 4,
    "detail": 1,
    "contrast": 1.2,
    "saturation": 0.6,
}


def load_key():
    """SPRITELAB_API_KEY のみを読む。ドットファイルは見ない。値は絶対に出力しない。"""
    k = os.environ.get("SPRITELAB_API_KEY")
    if not k:
        sys.exit(
            "SPRITELAB_API_KEY が設定されていません。実際の生成には環境変数 "
            "SPRITELAB_API_KEY にAPIキーを設定してください "
            "(--dry-run はキー無しで動作します)。"
        )
    return k.strip()


def discover_prompts():
    """art/prompts/ 配下の *.txt を走査し、style_notes.txt を除いた
    {asset_id: prompt_text} を返す。"""
    if not os.path.isdir(PROMPT_DIR):
        return {}
    out = {}
    for fn in sorted(os.listdir(PROMPT_DIR)):
        if not fn.endswith(".txt"):
            continue
        if fn == STYLE_NOTES_FILE:
            continue
        asset_id = fn[:-4]
        with open(os.path.join(PROMPT_DIR, fn), encoding="utf-8") as f:
            out[asset_id] = f.read().strip()
    return out


def load_style_notes():
    p = os.path.join(PROMPT_DIR, STYLE_NOTES_FILE)
    if not os.path.exists(p):
        sys.exit(f"style_notes.txt が見つかりません: {p}")
    with open(p, encoding="utf-8") as f:
        return f.read().strip()


def resolved_params(args):
    return {
        "quality": args.quality,
        "width": args.width,
        "height": args.height,
        "pixel_scale": args.pixel_scale,
        "max_colours": args.max_colours,
        "detail": args.detail,
        "contrast": args.contrast,
        "saturation": args.saturation,
    }


def build_body(prompt, style_notes, params):
    body = {"prompt": prompt, "style_notes": style_notes}
    body.update(params)
    return body


def call_spritelab(prompt, style_notes, params, key, timeout=400):
    """実際にネットワークへ POST する。dry-run では絶対に呼ばれない。"""
    body = json.dumps(build_body(prompt, style_notes, params)).encode()
    req = urllib.request.Request(
        API,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def decode_image_b64(image_b64):
    """"data:image/png;base64,AAAA..." 形式の prefix があれば剥がしてデコードする。"""
    return base64.b64decode(image_b64.split(",")[-1])


# --------------------------------------------------------------------------
# ポストプロセス (PIL 依存。--dry-run 含めネットワークとは無関係)
# --------------------------------------------------------------------------

# index 0 = 最も明るい/最も薄い色
DMG_PALETTE = [
    (0x9B, 0xBC, 0x0F),  # 0
    (0x8B, 0xAC, 0x0F),  # 1
    (0x30, 0x62, 0x30),  # 2
    (0x0F, 0x38, 0x0F),  # 3
]


def downsample(image, size):
    """PIL Image を (size, size) へ高品質縮小する。

    LANCZOS で滑らかに縮小してからアップサンプル無しでそのまま返す
    (最終的な色数への丸めは quantize_to_dmg 側で行う)。
    """
    from PIL import Image

    if isinstance(size, int):
        size = (size, size)
    return image.convert("RGB").resize(size, Image.LANCZOS)


def _nearest_palette_index(rgb):
    r, g, b = rgb
    best_i, best_d = 0, None
    for i, (pr, pg, pb) in enumerate(DMG_PALETTE):
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if best_d is None or d < best_d:
            best_d, best_i = d, i
    return best_i


def quantize_to_dmg(image):
    """RGB Image を DMG 4 階調グリーンへハードエッジで量子化する。

    ディザは掛けない。各ピクセルを DMG_PALETTE の最近傍色 (RGB ユークリッド距離)
    へ丸め、量子化後の RGB Image と、パレットインデックス(0-3)の
    行優先フラットリストの両方を返す。
    """
    from PIL import Image

    rgb = image.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    indices = [0] * (w * h)
    out = Image.new("RGB", (w, h))
    outpx = out.load()
    for y in range(h):
        for x in range(w):
            idx = _nearest_palette_index(px[x, y])
            indices[y * w + x] = idx
            outpx[x, y] = DMG_PALETTE[idx]
    return out, indices, w, h


def export_js(indices, width, height, name, out_dir=GENERATED_DIR):
    """量子化済みパレットインデックス配列を art/generated/<name>.js へ書き出す。

    フォーマット: 行優先 (row-major) のフラット配列。
    y*width + x でインデックスへアクセスする。
    """
    os.makedirs(out_dir, exist_ok=True)
    const = name.upper()
    path = os.path.join(out_dir, f"{name}.js")
    lines = [
        "// 自動生成ファイル。tools/spritelab_gen.py の export_js() が書き出す。",
        "// TILE_<NAME> はパレットインデックス (0-3, RGBではない) の",
        "// 行優先 (row-major) フラット配列: index = y * WIDTH + x",
        f"export const TILE_{const}_WIDTH = {width};",
        f"export const TILE_{const}_HEIGHT = {height};",
        f"export const TILE_{const} = {json.dumps(indices)};",
        "",
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# --------------------------------------------------------------------------
# raw PNG (512x512, 平坦な単色背景) → 実行時タイル配列 への変換パイプライン。
# オフライン一発生成。ここで生成した art/generated/<id>.js だけを実行時 (src/*.js)
# はimportする。ゲーム実行時にPNGを読んだり画像デコードを行うことは絶対にない。
#
# 出力フォーマット: 行優先フラット配列、値は 0-4。
#   0-3 = DMG_PALETTE のインデックス(0=最明...3=最暗。gfx.js の PALETTE 配列と同じ順序convention)
#   4   = 透明（背景を境界からのflood fillで検出したピクセルのみ。被写体内部の同色領域は残す）
# --------------------------------------------------------------------------

TRANSPARENT_INDEX = 4


def get_background_rgb(image):
    """左上ピクセルを背景色として採用する（raw art は角が完全な単色である前提）。"""
    px = image.load()
    return px[0, 0]


def downscale_for_tile(image, target):
    """area-average (BOX) で目標サイズまで一気に縮小する。

    実験の結果: area-average の後に NEAREST でもう一段階落とすと、その NEAREST が
    単純な間引きサンプリングになって細部（柵の横バー等）がノイズ状に欠落し、
    シルエットが「もっさり」崩れることが分かった。BOX 一発で目標サイズへ縮小する方が
    各出力ピクセルが元絵の対応領域を平均するため、輪郭が安定して視認できる。
    """
    from PIL import Image

    return image.resize((target, target), Image.BOX)


def flood_fill_background(indices, width, height, bg_index):
    """境界(外周)から内向きに bg_index と同じ値のピクセルだけを辿って TRANSPARENT_INDEX にする。

    4方向連結の反復flood fill（スタック使用、再帰なし）。外周と繋がっていない
    被写体内部の同色領域（例: 目、ボディの陰影で背景と同じ階調になった箇所）は
    辿り着けないので消されない。
    """
    out = list(indices)
    visited = [False] * (width * height)
    stack = []

    def push(x, y):
        if 0 <= x < width and 0 <= y < height:
            stack.append((x, y))

    for x in range(width):
        push(x, 0)
        push(x, height - 1)
    for y in range(height):
        push(0, y)
        push(width - 1, y)

    while stack:
        x, y = stack.pop()
        p = y * width + x
        if visited[p]:
            continue
        if out[p] != bg_index:
            continue
        visited[p] = True
        out[p] = TRANSPARENT_INDEX
        push(x - 1, y)
        push(x + 1, y)
        push(x, y - 1)
        push(x, y + 1)

    return out


def _luminance(rgb):
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b


def _normalize_and_quantize_subject(image, is_background, width, height, dark_bias, max_idx=3):
    """被写体(非背景)ピクセルの輝度レンジを 0..max_idx の全域へ正規化して割り付ける。

    dark_bias=True: 被写体の大部分が暗い側(index高め)に乗るようガンマを掛け、
    明るいハイライトのみ index0付近として少量残す(路面上でシルエットが読めるように)。
    dark_bias=False (explosion専用): 逆に明るい側(index0付近)へ寄せる。

    max_idx: 出力インデックスの上限(0..max_idx に収める)。

    背景(is_background=True)のピクセルは TRANSPARENT_INDEX のまま返す
    (このあと flood_fill_background の対象にはしないが、値は既に透明扱い)。
    """
    px = image.load()
    lum = [0.0] * (width * height)
    subject_lums = []
    for y in range(height):
        for x in range(width):
            p = y * width + x
            l = _luminance(px[x, y])
            lum[p] = l
            if not is_background[p]:
                subject_lums.append(l)

    if subject_lums:
        lo, hi = min(subject_lums), max(subject_lums)
    else:
        lo, hi = 0.0, 255.0
    span = hi - lo
    if span < 1e-6:
        span = 1.0

    # dark_bias時: 明部を狭く、暗部を広く割り当てるガンマ(>1)。
    # explosion時: 逆に暗部を狭く、明部を広く割り当てるガンマ(<1)。
    gamma = 2.2 if dark_bias else (1.0 / 2.2)

    out = [TRANSPARENT_INDEX] * (width * height)
    for y in range(height):
        for x in range(width):
            p = y * width + x
            if is_background[p]:
                continue
            b = (lum[p] - lo) / span  # 0(被写体内で最も暗い)..1(被写体内で最も明るい)
            if b < 0.0:
                b = 0.0
            elif b > 1.0:
                b = 1.0
            b_biased = b ** gamma
            idx = round((1.0 - b_biased) * max_idx)  # index0=最明...index(max_idx)=最暗
            if idx < 0:
                idx = 0
            elif idx > max_idx:
                idx = max_idx
            out[p] = idx
    return out


def convert_raw_to_indices(name, target, max_idx=3):
    """art/raw/<name>.png を読み、(indices, width, height) を返す（透明index4込み）。

    背景マスクの検出は従来通り(絶対色でのnearest-palette量子化 + 外周flood fill)。
    被写体ピクセルの階調は、そのマスクを使って輝度レンジを0..max_idxへ正規化・バイアスして
    決める(quantize_to_dmgの絶対色マッチングはここでは使わない)。

    max_idx=2 を指定すると、最暗色index3を使わずに被写体を量子化する。
    """
    from PIL import Image

    src_path = os.path.join(RAW_DIR, f"{name}.png")
    image = Image.open(src_path).convert("RGB")
    bg_rgb = get_background_rgb(image)
    bg_index = _nearest_palette_index(bg_rgb)

    small = downscale_for_tile(image, target)
    w, h = small.size

    # 背景マスクだけを従来ロジックで求める。
    _, naive_indices, _, _ = quantize_to_dmg(small)
    naive_indices = flood_fill_background(naive_indices, w, h, bg_index)
    is_background = [v == TRANSPARENT_INDEX for v in naive_indices]

    dark_bias = (name != "explosion")
    indices = _normalize_and_quantize_subject(small, is_background, w, h, dark_bias, max_idx)
    return indices, w, h


def export_tile_js(indices_by_const, width, height, filename, out_dir=GENERATED_DIR):
    """{const_name: indices} の1つ以上の組を1ファイルへ書き出す(1アセット1ファイル、
    explosionのみ3フレーム分を1ファイルにまとめる)。"""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{filename}.js")
    lines = [
        f"// 自動生成ファイル。tools/spritelab_gen.py の convert_all_art() が art/raw/{filename}.png から書き出す。",
        "// 値は 0-4 の行優先(row-major)フラット配列: index = y * WIDTH + x",
        "// 0-3 = DMGパレットindex(0=最明...3=最暗。gfx.js の PALETTE と同じ順序)",
        "// 4   = 透明（境界からのflood fillで検出した外側の背景ピクセルのみ）",
        f"export const TILE_{filename.upper()}_WIDTH = {width};",
        f"export const TILE_{filename.upper()}_HEIGHT = {height};",
    ]
    for const_name, indices in indices_by_const.items():
        lines.append(f"export const {const_name} = {json.dumps(indices)};")
    lines.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


# 16x16に落とす通常アセット。(raw名, 出力ファイル名(=定数名の元), 定数名, target, max_idx)
# 障害物(obstacle_*)は当たり判定のある危険物なので index3 を許容する。
SPRITE_CONVERT_SPECS = [
    ("player_buggy", "player_buggy", "TILE_PLAYER_BUGGY", 16, 3),
    ("enemy_bike", "enemy_bike", "TILE_ENEMY_BIKE", 16, 3),
    ("enemy_car", "enemy_car", "TILE_ENEMY_CAR", 16, 3),
    ("obstacle_rock", "obstacle_rock", "TILE_OBSTACLE_ROCK", 16, 3),
    ("obstacle_fence", "obstacle_fence", "TILE_OBSTACLE_FENCE", 16, 3),
    ("obstacle_cactus", "obstacle_cactus", "TILE_OBSTACLE_CACTUS", 16, 3),
]


def erode_indices(indices, width, height):
    """非透明ピクセルのうち、上下左右のいずれかが透明(または画面外)に接しているものを
    透明にする。シルエットを1px分だけ内側へ縮める（爆発の「小」フレーム用）。"""
    out = list(indices)
    for y in range(height):
        for x in range(width):
            p = y * width + x
            if indices[p] == TRANSPARENT_INDEX:
                continue
            touches_edge = False
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if nx < 0 or nx >= width or ny < 0 or ny >= height:
                    touches_edge = True
                    break
                if indices[ny * width + nx] == TRANSPARENT_INDEX:
                    touches_edge = True
                    break
            if touches_edge:
                out[p] = TRANSPARENT_INDEX
    return out


def dilate_indices(indices, width, height):
    """透明ピクセルのうち、上下左右のいずれかが非透明に接しているものを、その隣接色で
    埋める。シルエットを1px分だけ外側へ膨らませる（爆発の「散」フレームの下地用）。"""
    out = list(indices)
    for y in range(height):
        for x in range(width):
            p = y * width + x
            if indices[p] != TRANSPARENT_INDEX:
                continue
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height and indices[ny * width + nx] != TRANSPARENT_INDEX:
                    out[p] = indices[ny * width + nx]
                    break
    return out


def scatter_indices(indices, width, height):
    """非透明ピクセルへ決定的な(乱数を使わない)市松状の穴を空け、破片が飛び散っている
    ように見せる（爆発の「散」フレーム用）。外周1pxは残しシルエット自体は崩さない。"""
    out = list(indices)
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            p = y * width + x
            if out[p] == TRANSPARENT_INDEX:
                continue
            if (x * 2 + y * 3) % 5 == 0:
                out[p] = TRANSPARENT_INDEX
    return out


def convert_explosion_frames():
    """explosion.png から 小→大→散 の3フレームを作る（すべて整数インデックス操作のみ、
    Math.random等は使わない。erode/dilate/市松穴あけの決定的な処理で表現する）。"""
    base, w, h = convert_raw_to_indices("explosion", 16)

    frame_small = erode_indices(base, w, h)  # 小: 縮めた輪郭
    frame_big = base  # 大: そのままの輪郭
    frame_scatter = scatter_indices(dilate_indices(base, w, h), w, h)  # 散: 膨らませて穴を空ける

    return export_tile_js(
        {
            "TILE_EXPLOSION_FRAME0": frame_small,
            "TILE_EXPLOSION_FRAME1": frame_big,
            "TILE_EXPLOSION_FRAME2": frame_scatter,
        },
        w,
        h,
        "explosion",
    )


def convert_all_art():
    """art/raw/*.png を全て art/generated/*.js へ変換する（--convert-art から呼ぶ）。"""
    written = []
    for raw_name, out_name, const_name, target, max_idx in SPRITE_CONVERT_SPECS:
        indices, w, h = convert_raw_to_indices(raw_name, target, max_idx)
        path = export_tile_js({const_name: indices}, w, h, out_name)
        written.append(path)

    # boss_rival は32x32のまま1ファイルに書き出す。4象限への分割はtiles.js(実行時JS)側で行う。
    boss_indices, bw, bh = convert_raw_to_indices("boss_rival", 32)
    written.append(export_tile_js({"TILE_BOSS_RIVAL": boss_indices}, bw, bh, "boss_rival"))

    written.append(convert_explosion_frames())
    return written


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", help="カンマ区切りの id (例 player_buggy,enemy_bike)")
    ap.add_argument("--all", action="store_true", help="全アセットを対象にする")
    ap.add_argument("--missing", action="store_true",
                     help="art/raw/<id>.png がまだ無いものだけ")
    ap.add_argument("--list", action="store_true", help="アセット一覧を表示")
    ap.add_argument("--convert-art", action="store_true",
                     help="art/raw/*.png を art/generated/*.js へ変換する(オフライン, "
                          "ネットワーク不使用, Pillowのみ使用)")
    ap.add_argument("--dry-run", action="store_true",
                     help="ネットワークに触れず、プロンプトとパラメータを表示するだけ")
    ap.add_argument("--quality", default=DEFAULTS["quality"])
    ap.add_argument("--width", type=int, default=DEFAULTS["width"])
    ap.add_argument("--height", type=int, default=DEFAULTS["height"])
    ap.add_argument("--pixel-scale", type=int, default=DEFAULTS["pixel_scale"],
                     dest="pixel_scale")
    ap.add_argument("--max-colours", type=int, default=DEFAULTS["max_colours"],
                     dest="max_colours")
    ap.add_argument("--detail", type=int, default=DEFAULTS["detail"])
    ap.add_argument("--contrast", type=float, default=DEFAULTS["contrast"])
    ap.add_argument("--saturation", type=float, default=DEFAULTS["saturation"])
    args = ap.parse_args()

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(GENERATED_DIR, exist_ok=True)

    if args.convert_art:
        paths = convert_all_art()
        for p in paths:
            print(f"wrote {p}")
        return

    prompts = discover_prompts()

    if args.list:
        for asset_id, p in sorted(prompts.items()):
            print(f"{asset_id:20s} {p[:80]}")
        return

    if args.only:
        names = [x.strip() for x in args.only.split(",") if x.strip()]
        unknown = [n for n in names if n not in prompts]
        if unknown:
            sys.exit(f"unknown asset id(s): {', '.join(unknown)}")
    elif args.missing:
        names = [
            n for n in prompts
            if not os.path.exists(os.path.join(RAW_DIR, n + ".png"))
        ]
    elif args.all:
        names = list(prompts.keys())
    else:
        sys.exit("--only / --all / --missing / --list のいずれかを指定してください")

    params = resolved_params(args)

    if args.dry_run:
        # ここで完全に終了する。この行より下には urlopen へ到達する経路は無い。
        style_notes = load_style_notes()
        for n in names:
            print(f"--- {n} ---")
            print(f"prompt: {prompts[n]}")
            print(f"style_notes: {style_notes}")
            print(f"params: {json.dumps(params, ensure_ascii=False)}")
            print()
        return

    # ここから先だけがネットワークに触れうる経路。dry-run では絶対に到達しない。
    style_notes = load_style_notes()
    key = load_key()

    ok = fail = 0
    for i, n in enumerate(names):
        out_path = os.path.join(RAW_DIR, n + ".png")
        for attempt in range(3):
            try:
                d = call_spritelab(prompts[n], style_notes, params, key)
                raw = decode_image_b64(d["image_b64"])
                with open(out_path, "wb") as f:
                    f.write(raw)
                ok += 1
                print(f"[{i + 1}/{len(names)}] {n} cost={d.get('cost')} "
                      f"credits={d.get('credits_remaining')}")
                break
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:200]
                print(f"[{i + 1}/{len(names)}] {n} HTTP {e.code} {msg}")
                if e.code in (401, 402, 403):
                    sys.exit("認証またはクレジットの問題。中断します")
                time.sleep(5)
            except Exception as e:
                print(f"[{i + 1}/{len(names)}] {n} {type(e).__name__}: {e}")
                time.sleep(5)
        else:
            fail += 1
    print(f"完了: 成功 {ok} / 失敗 {fail}")


if __name__ == "__main__":
    main()
