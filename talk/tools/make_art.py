"""Generate the talk's canvas SVGs (photos, video, mapping table) into <talk>/art/.

Inline SVG: hrefs resolve against deck.html, so media paths are 'media/<file>'.
Colours come from theme tokens (var(--text), var(--chapter)) so the art follows the theme.
Text is pre-wrapped; sizes are >= 40px nominal so the canvas can scale ~0.85 and stay >= 34px.
"""
import sys
from pathlib import Path
from html import escape

TALK = Path(sys.argv[1])
ART = TALK / "art"
ART.mkdir(exist_ok=True)
W = 1728
_clip = 0


def svg(h, body, label):
    return (f'<svg class="art" viewBox="0 0 {W} {h}" width="{W}" role="img" aria-label="{escape(label)}" '
            f'xmlns="http://www.w3.org/2000/svg">\n{body}\n</svg>\n')


def photo(x, y, w, h, href, fit="slice", r=18):
    global _clip
    _clip += 1
    cid = f"c{_clip}-{Path(href).stem}"
    return (f'<clipPath id="{cid}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}"/></clipPath>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" style="fill:var(--hair-soft)"/>'
            f'<image href="{href}" x="{x}" y="{y}" width="{w}" height="{h}" '
            f'preserveAspectRatio="xMidYMid {fit}" clip-path="url(#{cid})"/>'
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" style="fill:none;stroke:var(--hair);stroke-width:2"/>')


def text(x, y, s, size=40, color="--text", weight=400, anchor="start"):
    return (f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" '
            f'style="fill:var({color})">{escape(s)}</text>')


def lines(x, y, rows, size=40, gap=1.3, color="--text", weight=400, anchor="start"):
    return "".join(text(x, y + i * size * gap, r, size, color, weight, anchor) for i, r in enumerate(rows))


def beat(n, inner, fx="fadeup", delay=0.0):
    d = f' data-delay="{delay:.2f}"' if delay else ""
    return f'<g data-beat="{n}" data-fx="{fx}"{d}>{inner}</g>'


def check_icon(x, y, s=34):
    return (f'<path d="M{x} {y + s*.55} L{x + s*.38} {y + s*.9} L{x + s} {y + s*.1}" '
            f'style="fill:none;stroke:var(--chapter);stroke-width:6;stroke-linecap:round;stroke-linejoin:round"/>')


def write(name, content):
    (ART / name).write_text(content, encoding="utf-8")
    print("wrote", ART / name)


# 1. News collage: six reports, one press, cascading pops.
tiles = [("news-de-shelf.jpg", "德國", "店內貨架"), ("news-de-lte.jpg", "德國", "Nano X"),
         ("news-jp-amazon.jpg", "日本", "Nano X"), ("news-sg-flex.jpg", "新加坡", "Flex"),
         ("news-ru-ozon.jpg", "俄羅斯", "Nano X"), ("news-my-stax.jpg", "CryptoBilis", "Stax")]
tw, th, gap = 272, 350, (W - 6 * 272) / 5
body = ""
for i, (f, place, model) in enumerate(tiles):
    x = round(i * (tw + gap))
    g = photo(x, 0, tw, th, f"media/{f}") + text(x + tw / 2, th + 52, place, 42, "--chapter", 700, "middle") \
        + text(x + tw / 2, th + 102, model, 40, "--text", 400, "middle")
    body += beat(1, g, "pop", i * 0.12)
write("news-collage.svg", svg(480, body, "2026 年 10 月各國通路回報的植入裝置照片"))

# 2. SP1/SP2/SP3 triptych, one press each.
sp = [("sp1.jpg", "SP1 騰出空間", ["電池 100→70 mAh", "電量計永遠顯示 100%"]),
      ("sp2.jpg", "SP2 植入位置", ["塞進電池讓出的腔體", "搭上 OLED 的 SPI"]),
      ("sp3.jpg", "SP3 植入接線", ["獨立小板接到主板", "不碰安全元件"])]
tw, th = 560, 320
body = ""
for i, (f, tag, rows) in enumerate(sp):
    x = i * (tw + 24)
    g = photo(x, 0, tw, th, f"media/{f}", "meet") + text(x, th + 58, tag, 44, "--chapter", 700) \
        + lines(x, th + 114, rows, 40)
    body += beat(i + 1, g, "pop")
write("sp-triptych.svg", svg(500, body, "植入三要素：縮電池、位置、接線（Joe Grand 實照）"))

# 3. Parts: Grand's labelled photo + four parts, one per press.
parts = [("MCU", "Cortex-M0+，晶片無標記"), ("4G 模組", "Luat Air700E（Cat.1bis）"),
         ("eSIM", "荷蘭 Vodafone「DATA ONLY」"), ("天線", "手繞線圈")]
body = photo(0, 0, 880, 495, "media/grand-p66.jpg", "meet")
for i, (k, v) in enumerate(parts):
    y = 10 + i * 120
    body += beat(i + 1, text(940, y + 44, k, 46, "--chapter", 700) + text(940, y + 98, v, 40))
write("parts.svg", svg(500, body, "植入板零件：MCU、4G 模組、eSIM、天線（Joe Grand 投影片 p.66）"))

# 4. Wiring: annotated test points + real wiring to the Feather + legend.
body = beat(1, photo(0, 0, 720, 466, "media/wire.jpg") + text(0, 522, "Nano X 主板的測試點（手寫標註）", 40))
body += beat(2, photo(752, 0, 350, 466, "media/jz-version.jpg") + text(752, 522, "接上 Feather RP2040", 40))
legend = text(1160, 50, "只接四條", 44, "--chapter", 700) + lines(1160, 116, ["CS", "CLK", "DAT", "GND"], 42) \
    + text(1160, 370, "不接", 44, "--chapter", 700) + lines(1160, 436, ["+5V、ON"], 42)
body += beat(3, legend)
write("wiring.svg", svg(545, body, "四線被動探針接在 Ledger Nano X 的顯示測試點"))

# 5. Demo: the recorded second screen, playing on loop as soon as the slide shows.
vw, vh = 1102, 620
vx = (W - vw) / 2
body = (f'<rect x="{vx}" y="0" width="{vw}" height="{vh}" rx="18" style="fill:#000"/>'
        f'<foreignObject x="{vx}" y="0" width="{vw}" height="{vh}">'
        f'<video xmlns="http://www.w3.org/1999/xhtml" src="media/2nd.mp4" poster="media/2nd-poster.jpg" '
        f'autoplay="" muted="" loop="" playsinline="" '
        f'style="width:100%;height:100%;object-fit:contain;border-radius:18px;display:block"></video>'
        f'</foreignObject>'
        f'<rect x="{vx}" y="0" width="{vw}" height="{vh}" rx="18" style="fill:none;stroke:var(--hair);stroke-width:2"/>')
write("demo.svg", svg(vh, body, "第二螢幕錄影：板子切畫面，終端鏡像同步重繪"))

# 6. Mapping table: Joe by hand -> jz with AI, one row per press.
cols = [(0, 250, "環節"), (270, 430, "Joe 怎麼做（手工）"), (720, 500, "jz：AI 起草"), (1240, 488, "我：真板驗收")]
rows = [("協定分析", ["Logic Pro 8 抓波形", "手工判讀"], ["由擷取流推回", "SSD1306 命令表"], ["真機八頁序列核對", "型號未確認就標明"]),
        ("解碼器", ["韌體內 a–z", "字形樣板比對"], ["欄位元組→畫面緩衝", "→ ASCII 鏡像"], ["肉眼對照", "實體螢幕一致"]),
        ("編碼器", ["擷取→存 flash", "→ 4G 外送"], ["PIO＋DMA＋USB 串流", "只讀、不外洩"], ["loopback 零錯", "真板抓出 bit-slip"]),
        ("接線", ["顯微焊上", "植入板"], ["避開 Feather 絲印坑", "選相鄰數位腳"], ["電表復驗", "先通電再搭線"])]
head = '<rect x="0" y="0" width="1728" height="70" rx="12" style="fill:var(--chapter);opacity:.18"/>'
for x, w, h in cols:
    head += text(x + 20, 50, h, 40, "--text", 700)
body = head
rh = 126
for i, (stage, joe, ai, me) in enumerate(rows):
    y = 86 + i * rh
    g = f'<line x1="0" y1="{y + rh - 6}" x2="1728" y2="{y + rh - 6}" style="stroke:var(--hair);stroke-width:2"/>'
    g += text(20, y + 70, stage, 44, "--text", 700)
    g += lines(290, y + 48, joe, 40)
    g += f'<rect x="{720}" y="{y + 4}" width="500" height="{rh - 18}" rx="12" style="fill:var(--accent-soft);opacity:.5"/>'
    g += lines(740, y + 48, ai, 40)
    g += check_icon(1256, y + 22) + lines(1306, y + 48, me, 40)
    body += beat(i + 1, g)
write("mapping.svg", svg(86 + 4 * rh, body, "置換對照：Joe 手工四環節，jz 版由 AI 起草、我真板驗收"))

# 7. Protocol analysis: Joe's capture (before) -> AI draft / my checks (after).
steps = [("AI 起草", ["由擷取流推回", "SSD1306 命令表"]), ("我核對", ["真機八頁序列", "欄定址重建規則"]),
         ("我設限", ["型號未確認就標明", "不明位元組保留"])]
body = photo(0, 0, 820, 461, "media/grand-p41.jpg", "meet") + text(0, 520, "Joe：Logic Pro 8 手工判讀 SPI", 40)
for i, (k, rws) in enumerate(steps):
    y = i * 168
    body += beat(i + 1, text(880, y + 50, k, 44, "--chapter", 700) + lines(880, y + 106, rws, 40))
write("protocol.svg", svg(540, body, "協定分析：Joe 手工判讀 vs AI 起草加真板核對"))

# 8. Decoder: same method, opposite use.
body = beat(1, photo(0, 0, 720, 405, "media/grand-p71.jpg", "meet") + text(0, 462, "Joe：植入把字形比對成助記詞", 40))
body += ('<path d="M828 202 L896 202" style="stroke:var(--chapter);stroke-width:8;stroke-linecap:round"/>'
         '<path d="M876 182 L900 202 L876 222" style="fill:none;stroke:var(--chapter);stroke-width:8;stroke-linecap:round;stroke-linejoin:round"/>')
body += beat(2, photo(1008, 0, 720, 405, "media/2nd-poster.jpg", "slice") + text(1008, 462, "jz：主機端把位元組重建成畫面", 40))
write("decoder.svg", svg(480, body, "解碼器：Joe 的植入解碼 vs jz 的主機端重建"))
