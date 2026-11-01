# 2nd-screen

**給 SPI 點陣顯示器加一個被動的「第二螢幕」。**

一片 Feather RP2040 被動搭在點陣顯示評估板的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；`live_mirror.py` 即時重建畫面，變成評估板的**第二螢幕**——在板子上切畫面，終端裡的鏡像同步跟著變。

## 效果

```
點陣顯示評估板                            Feather RP2040            主機（第二螢幕）
┌───────────────┐   被動高阻抗探針        ┌──────────────┐  USB CDC  ┌────────────────┐
│ 控制器 ─> OLED │─ DI / CLK / CS / GND ─>│ PIO 取樣+DMA │─ 封包 ──> │ live_mirror.py │
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

- 預設等待完整 `B0..B7` 頁序列（每頁 128 B），才更新畫面；`--page` 亦可明確指定此模式。
- `--raw`：顯示最新 1024 B 的未對齊診斷畫面。
- `--file <capture>`：不接硬體，重播擷取檔。
- 即時執行會自動將全部原始輸入存至 `_output/captures/`，另存有時間戳的 `.events.jsonl`，含未用於完整幀的 bytes、封包序號與 loss counters。用 `--capture _output/pin-test.bin` 自訂檔名（不覆寫既有檔案）。
- `.events.jsonl` 的 `display_commands` 會註解已辨識的 clock、contrast、display mode、scan direction、segment mapping 與 page 命令；其餘資料仍列為 `unmatched_bus_bytes`。
- 先確認板子狀態：`python3 poc/host/usb_probe.py`（回報 BOOTSEL／RUNNING／ABSENT）。

## 運作原理

- **韌體**（`spi_tap.c` + `.pio`）：PIO 以 CS 為 frame 邊界、在 CLK 邊緣取樣 DI、autopush 成位元組，DMA 持續寫入 32 KiB ring，經 USB CDC 以 binary 串流；不因 USB 傳送停止擷取，bus 閒置 2 ms 就送一包，控制指令與 frame 同包（約 9.6 fps 真板實測約 1.4 kB/s）。所有探針腳全程輸入、硬體鎖成永不驅動（純被動）。每包可選無損 RLE，詳見主文件。
- **主機端**（`live_mirror.py`）：把位元組流當垂直欄像素打包（欄定址、每欄 8 垂直位元）重建 128×64 framebuffer，印成半格 ASCII——就是第二螢幕。
- **診斷**（`bus_probe.c`）：無示波器時用 RP2040 的真輸入門檻硬體計 CLK 上升緣，直接回答「這條匯流排讀不讀得到」。

實機被動擷取成功：切畫面時約 8312 邊緣/重繪 ≈ 一張 128×64 全畫面，更新行為符合 write-on-change。CLK 的 1.8 V 是 DC 電表讀值，未確認訊號振幅與電氣容限。細節見 [`docs/2nd-screen.md`](docs/2nd-screen.md)。

## 安全與範圍

探針全程只讀；不接 +5V；不做主動回寫。見主文件的[範圍](docs/2nd-screen.md#範圍)與[安全護欄](docs/2nd-screen.md#安全護欄)。

## 目錄

```
docs/2nd-screen.md     主文件（量測、結果、接線、方法、demo）
docs/bluefruit-ble.md  BLE 開發資料（尚未實作）
poc/rp2040-spi-tap/        RP2040 被動擷取韌體（spi_tap / bus_probe）
poc/host/                    主機端工具（live_mirror / usb_probe）
poc/lima/pico.yaml           工具鏈 VM（替代 host build）
tickets/                     工作佇列（以 CLI 讀：node tickets/engine/cli.mjs next|list）
```
