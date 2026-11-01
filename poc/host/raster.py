#!/usr/bin/env python3
# 單張畫面檢視器——spi_tap 的擷取位元組 → 垂直欄點陣 → ASCII 畫面。
# ---------------------------------------------------------------------------
# 把一個擷取檔還原成一張靜態畫面（live_mirror.py 是串流即時版）。位元組依一般點陣
# OLED 控制器的「每位元組＝一欄 8 垂直像素」佈局重建。
#
# 限制（見 docs/2nd-screen.md）：
#   - 四線被動探針不含 D/C 線，命令位元組與像素位元組混在流裡、無法硬分；像素佔絕大宗
#     （每幀約 1024 B），故以「非零密度最高的 1024 B 視窗」當一幀來看。
#   - 擷取起點落在資料流中段、命令位元組會位移欄對齊，故畫面可能偏移/疊影；頁/欄 opcode
#     的精確對齊以實際擷取為準。
#
# 用法：
#   python3 usb_probe.py --read 32 > cap.txt   # 先擷取（切畫面製造流量）
#   python3 raster.py cap.txt                  # 還原最密的一幀成 ASCII
#   python3 raster.py cap.txt --all            # 逐 1024 B 視窗全部印出
# 純標準庫；吃 usb_probe.py 的輸出（每行最多 32 B 十六進位，忽略非 hex 行如 banner）。
import re
import sys

W, H = 128, 64
FRAME = W * H // 8  # 1024 B：128 欄 × 8 頁

def load_bytes(path):
    by = bytearray()
    with open(path) as f:
        for ln in f:
            ln = ln.strip()
            if re.fullmatch(r'[0-9a-f]{2,64}', ln):
                by += bytes.fromhex(ln)
    return bytes(by)

def render_frame(frame):
    """1024 B 垂直欄打包 → 64×128 像素 → 半格 ASCII（上下兩像素合一字元）。"""
    rows = [[0] * W for _ in range(H)]
    for page in range(8):
        for col in range(W):
            idx = page * W + col
            if idx < len(frame):
                v = frame[idx]
                for bit in range(8):
                    rows[page * 8 + bit][col] = (v >> bit) & 1  # bit0 = 最上列
    gl = {(0, 0): ' ', (1, 0): '▀', (0, 1): '▄', (1, 1): '█'}
    return "\n".join("".join(gl[(rows[y][x], rows[y + 1][x])] for x in range(W))
                     for y in range(0, H, 2))

def main():
    args = sys.argv[1:]
    if not args:
        print("usage: raster.py <capture.txt> [--all]")
        return 2
    path = args[0]
    by = load_bytes(path)
    print(f"# {len(by)} bytes")
    if not by:
        print("# 沒有 hex 資料（擷取時匯流排有活動嗎？翻選單製造流量再擷取）")
        return 1

    if "--all" in args:
        for off in range(0, len(by), FRAME):
            chunk = by[off:off + FRAME]
            nz = sum(1 for x in chunk if x)
            print(f"\n# frame @ {off} (nonzero={nz})")
            print(render_frame(chunk))
        return 0

    # 預設：掃出非零密度最高的 1024 B 視窗（步進 64 B 找較佳欄對齊）當一幀。
    best_off, best_nz = 0, -1
    for off in range(0, max(1, len(by) - FRAME + 1), 64):
        nz = sum(1 for x in by[off:off + FRAME] if x)
        if nz > best_nz:
            best_off, best_nz = off, nz
    print(f"# densest 1024B frame at offset {best_off} (nonzero={best_nz})\n")
    print(render_frame(by[best_off:best_off + FRAME]))
    return 0

if __name__ == "__main__":
    sys.exit(main())
