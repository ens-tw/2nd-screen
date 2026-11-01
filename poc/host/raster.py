"""128x64 page-packed framebuffer -> half-block ASCII, shared by the host tools."""

W, H = 128, 64
FRAME = W * H // 8  # 1024 B: 128 columns x 8 pages


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
