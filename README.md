# 2nd-screen

**給 SPI 點陣顯示器加一個被動的「第二螢幕」。**

一片 Feather RP2040 被動搭在點陣顯示評估板的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；`live_mirror.py` 即時重建畫面，變成評估板的**第二螢幕**——在板子上切畫面，終端裡的鏡像同步跟著變。

探針全程**只讀、不驅動任何線**。順帶的安全含義：**可及的明文顯示匯流排，內容就守不住**。

## 效果

```
點陣顯示評估板                            Feather RP2040            主機（第二螢幕）
┌───────────────┐   被動高阻抗探針        ┌──────────────┐  USB CDC  ┌────────────────┐
│ 控制器 ─> OLED │─ DI / CLK / CS / GND ─>│ PIO 取樣+DMA │─ hex ───> │ live_mirror.py │
└───────────────┘                        └──────────────┘           │  → ASCII 畫面  │
                                                                     └────────────────┘
```

已於真機驗證：被動搭四線即可即時鏡像出肉眼可讀的畫面。

## 快速開始

需要 `arm-none-eabi-gcc`、`cmake`、`ninja`、`picotool`，以及 `~/pico-sdk`（含 `lib/tinyusb`）。

```bash
# 1) 建置韌體
export PICO_SDK_PATH=$HOME/pico-sdk
cmake -S poc/rp2040-spi-tap -B poc/build/spi-tap -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C poc/build/spi-tap spi_tap bus_probe

# 2) 燒錄被動擷取韌體（軟體進 BOOTSEL；無 EDR 機器可用）
picotool load -x -f poc/build/spi-tap/spi_tap.uf2

# 3) 第二螢幕（在你自己的終端跑，要真 TTY）
python3 poc/host/live_mirror.py
```

接著**喚醒評估板並切畫面**（裝置閒置若會自動關機，第二螢幕需裝置開機且在重繪才有畫面）。

- `--page`：畫面橫向位移嚴重時，改用 頁命令對齊重建。
- `--file <capture>`：不接硬體，重播一個擷取檔。
- 先確認板子狀態：`python3 poc/host/usb_probe.py`（回報 BOOTSEL／RUNNING／ABSENT）。

## 運作原理

- **韌體**（`spi_tap.c` + `.pio`）：PIO 以 CS 為 frame 邊界、在 CLK 邊緣取樣 DI、autopush 成位元組，DMA 收進緩衝後經 USB CDC 以 hex 倒出。所有探針腳全程輸入、硬體鎖成永不驅動（純被動）。
- **主機端**（`live_mirror.py` / `raster.py`）：把位元組流當垂直欄像素打包（欄定址、每欄 8 垂直位元）重建 128×64 framebuffer，印成半格 ASCII——就是第二螢幕。`live_mirror.py` 串流即時重繪；`raster.py` 把單一擷取檔還原成一張靜態畫面。
- **診斷**（`bus_probe.c`）：無示波器時用 RP2040 的真輸入門檻硬體計 CLK 上升緣，直接回答「這條匯流排讀不讀得到」。
- 本 repo **只做像素鏡像，不含 OCR／內容還原**。

實機量到：1.8V 的 CLK 跨得過 RP2040 門檻（切畫面時約 8312 邊緣/重繪 ≈ 一張 128×64 全畫面），為 write-on-change，**不需電平轉換**。細節見 [`docs/2nd-screen.md`](docs/2nd-screen.md)。

## 安全與範圍

- 只在**自有、無敏感內容**的評估板上操作；擷取資料不離開評估環境。
- 探針被動、只讀、不回寫；唯一共用的電源連線是 `GND`（不接 +5V，避免回灌燒件）。
- 不含隱藏封裝、外傳通道，或任何「藏進成品」的內容。

## 目錄

```
docs/2nd-screen.md     主文件（量測、結果、接線、方法、demo）
poc/rp2040-spi-tap/        RP2040 被動擷取韌體（spi_tap / bus_probe / loopback_test）
poc/host/                    主機端工具（live_mirror / raster / usb_probe）
poc/lima/pico.yaml           工具鏈 VM（替代 host build）
tickets/                     工作佇列（以 CLI 讀：node tickets/engine/cli.mjs next|list）
```
