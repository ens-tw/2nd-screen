#!/usr/bin/env python3
# 即時畫面鏡像（PoC 主效果）——被動 SPI 擷取 → 即時 ASCII 重現評估板畫面。
# ---------------------------------------------------------------------------
# 把 spi_tap 經 USB CDC 連續倒出的真匯流排位元組，邊收邊重建 framebuffer、在終端
# **原地重繪**成 128×64 的 ASCII「螢幕」。你在評估板上切畫面，這裡幾乎同步跟著變——
# 這就是 docs/2nd-screen.md 的 PoC 目標：證明被動搭四條線即可旁觀顯示內容。
# 純畫面鏡像、不含任何內容解讀邏輯。
#
# 對照：raster.py = 單張靜態還原（檔案）；本檔 = 即時串流鏡像（活體）。
#       兩者共用「垂直欄打包」的重建。
#
# 用法（在你自己的終端跑，要真 TTY 才有原地重繪動畫）：
#   1) 先燒 spi_tap（block 已調成 2048 低延遲）：
#        picotool load -x -f poc/build/spi-tap/spi_tap.uf2
#   2) python3 poc/host/live_mirror.py              # 連上板子、即時鏡像，Ctrl-C 離開
#      python3 poc/host/live_mirror.py --page       # 改用「頁命令對齊」重建（偏移嚴重時試）
#      python3 poc/host/live_mirror.py --file cap.txt  # 不連板子，重播一個擷取檔（驗證用）
#      python3 poc/host/live_mirror.py --seconds 20  # 跑固定秒數後退出（非 TTY 自動靜態輸出）
# 純標準庫；吃 usb_probe.py 的輸出格式（每行最多 32 B 十六進位，忽略 banner 等非 hex 行）。
import os
import re
import select
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usb_probe import find_running_ports          # noqa: E402  (同目錄工具)
from raster import render_frame, FRAME, W, H       # noqa: E402

RECENT = 4096          # 保留最近 N 位元組，供對齊搜尋
_HEX_RE = re.compile(rb'[0-9a-f]{2,64}')

# ── 終端控制序列（只在真 TTY 用）──
_ALT_ON, _ALT_OFF = "\x1b[?1049h", "\x1b[?1049l"
_CUR_OFF, _CUR_ON = "\x1b[?25l", "\x1b[?25h"
_HOME = "\x1b[H"
_OLED, _RST = "\x1b[97m", "\x1b[0m"

def densest_frame(buf):
    """最近緩衝裡非零密度最高的 1024 B 視窗（步進 32 找較佳欄對齊）。"""
    best_off, best_nz = 0, -1
    end = max(1, len(buf) - FRAME + 1)
    for off in range(0, end, 32):
        nz = sum(1 for x in buf[off:off + FRAME] if x)
        if nz > best_nz:
            best_off, best_nz = off, nz
    return buf[best_off:best_off + FRAME]

def page_frame(buf):
    """實驗性：靠 頁命令(0xB0..0xB7)對齊——命令後取 128 B 當該頁像素。
    對付「每頁命令位元組插入造成逐頁橫向位移」。像素偶爾撞到 0xBn 會有小雜訊。"""
    fb = bytearray(FRAME)
    i, n = 0, len(buf)
    seen = False
    while i < n:
        b = buf[i]
        if 0xB0 <= b <= 0xB7:
            seen = True
            page = b & 0x07
            j = i + 1
            while j < n and buf[j] <= 0x1F and (j - i) <= 3:  # 跳過緊接的欄位址命令
                j += 1
            seg = buf[j:j + W]
            base = page * W
            for k, v in enumerate(seg):
                if base + k < FRAME:
                    fb[base + k] = v
            i = j + len(seg)
        else:
            i += 1
    return bytes(fb) if seen else None

def make_frame(buf, use_page):
    if use_page:
        f = page_frame(buf)
        if f is not None:
            return f
    return densest_frame(buf)

def box(art, status, color=True):
    label = " DOT-MATRIX EVAL BOARD  128x64  — passive bus mirror "
    top = "┌" + label + "─" * (W - len(label)) + "┐"
    lines = [top]
    for ln in art.split("\n"):
        body = (_OLED + ln + _RST) if color else ln
        lines.append("│" + body + "│")
    lines.append("└" + "─" * W + "┘")
    lines.append(status)
    return "\n".join(lines) + "\n"

def feed_hex(line_bytes, acc):
    """把一行（可能含非 hex）擷出 hex → 累積位元組。"""
    for m in _HEX_RE.findall(line_bytes):
        try:
            acc += bytes.fromhex(m.decode())
        except ValueError:
            pass

def run_live(dev, use_page, seconds):
    tty = sys.stdout.isatty()
    try:
        fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
    except OSError as e:
        print(f"無法開啟 {dev}：{e}")
        return 1
    acc = bytearray()
    linebuf = bytearray()
    deadline = (time.time() + seconds) if seconds else None
    last_render, frames = 0.0, 0
    if tty:
        sys.stdout.write(_ALT_ON + _CUR_OFF)
        sys.stdout.flush()
    try:
        while deadline is None or time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if chunk:
                    linebuf += chunk
                    while b"\n" in linebuf:
                        line, _, linebuf = linebuf.partition(b"\n")
                        feed_hex(line, acc)
                    if len(acc) > RECENT:
                        del acc[:-RECENT]
            now = time.time()
            if now - last_render >= 0.15 and len(acc) >= FRAME:
                frame = make_frame(bytes(acc), use_page)
                art = render_frame(frame)
                frames += 1
                status = (f"frames={frames}  buf={len(acc)}B  "
                          f"{'page-align' if use_page else 'densest'}  "
                          f"(切評估板畫面看鏡像跟著變；Ctrl-C 離開)")
                if tty:
                    sys.stdout.write(_HOME + box(art, status, color=True))
                else:
                    sys.stdout.write("\n" + box(art, status, color=False))
                sys.stdout.flush()
                last_render = now
    except KeyboardInterrupt:
        pass
    finally:
        os.close(fd)
        if tty:
            sys.stdout.write(_CUR_ON + _ALT_OFF)
            sys.stdout.flush()
    if frames == 0:
        print("（沒有畫面資料——評估板開機了嗎？切一下畫面製造匯流排活動。）")
    return 0

def run_file(path, use_page):
    by = bytearray()
    for ln in open(path):
        feed_hex(ln.encode(), by)
    if not by:
        print("# 檔案裡沒有 hex 資料")
        return 1
    frame = make_frame(bytes(by), use_page)
    print(box(render_frame(frame),
              f"{len(by)}B  {'page-align' if use_page else 'densest'}  (file replay)",
              color=sys.stdout.isatty()))
    return 0

def main():
    args = sys.argv[1:]
    use_page = "--page" in args
    seconds = 0.0
    if "--seconds" in args:
        try:
            seconds = float(args[args.index("--seconds") + 1])
        except (IndexError, ValueError):
            pass
    if "--file" in args:
        return run_file(args[args.index("--file") + 1], use_page)

    ports = find_running_ports()
    if not ports:
        print("找不到 RP2040 序列埠。先確認板子在跑 spi_tap（usb_probe.py 回報 RUNNING）。")
        return 1
    return run_live(ports[0][2], use_page, seconds)

if __name__ == "__main__":
    sys.exit(main())
