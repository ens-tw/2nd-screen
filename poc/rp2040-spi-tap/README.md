# rp2040-spi-tap

被動 SPI 擷取韌體，供 `docs/2nd-screen.md` 的桌上評估使用。
**只抄匯流排位元組，不含任何畫面內容解讀邏輯**；還原在主機端做（`poc/host/`）。

## 檔案

- `spi_tap.pio` — PIO 擷取程式：CS 為 frame 邊界，CLK 邊緣取樣 DI，autopush 成位元組。
- `spi_tap.c` — SDK 初始化、PIO/DMA 設定、連續 DMA ring 擷取，以 STP2 binary 封包經 USB CDC 串流。
- [`display-write-test.md`](display-write-test.md) / `display_write_test.c` — 獨立的主動回寫實驗：USB 接收一張完整 frame，驗證後送出一次並回到輸入；需原控制器隔離／交接、電壓驗證與額外 D/C 接線，不能用現有四線並接直接回寫。
- `CMakeLists.txt` — 建置設定（板子預設 `adafruit_feather_rp2040`）。
- `wiring.html` — 接線圖：Feather RP2040 探針腳位示意 ＋ 腳位對照表、安全護欄、燒錄／讀取指令。用 `qlmanage -p wiring.html` 或瀏覽器開啟。
- [`bluefruit-wiring.html`](bluefruit-wiring.html) — Feather RP2040 ↔ Bluefruit LE UART Friend 六線接線指南（含 RTS/CTS、SDA/SCL 的 UART 腳位對照、模式切換與可列印檢查表）；UART/BLE bridge 韌體待實作。
- `ref/` — 定位用原圖：`feather-rp2040-pinout-annotated.png`（Adafruit 官方 PrettyPins，已圈出 D10/D11/D12/GND 搭線腳）。目標評估板側的 SPI 測試點（DI/CLK/CS/GND）請依該板資料手冊／原理圖定位。

## 建置（在 Lima VM `pico` 內）

VM 已把整個 `poc/` 掛進來，原始碼在 `poc/rp2040-spi-tap/`，輸出到 `poc/build/`。
⚠ Lima 把主機路徑掛在 VM 內的**相同絕對路徑**（不是 `~/` 底下），所以 VM 裡用 `/Users/...`：

```bash
limactl shell pico
export PICO_SDK_PATH=$HOME/pico-sdk
SRC=$HOME/cbx/2nd-screen/poc/rp2040-spi-tap
OUT=$HOME/cbx/2nd-screen/poc/build/spi-tap
cmake -S "$SRC" -B "$OUT" -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C "$OUT" spi_tap
# 產出 $OUT/spi_tap.uf2
```

## 燒錄與讀取

1. 進 BOOTSEL：按住 BOOTSEL、點一下 RESET（或按住 BOOTSEL 再插 USB）。
1. 燒錄（主機端，不進 VM，直接走 USB，燒完自動執行）：
   ```bash
   picotool load -x poc/build/spi-tap/spi_tap.uf2
   ```
   ⚠ 近期 macOS（fskit 的 msdos 驅動）會把 `RPI-RP2` 掛成**唯讀**，拖放 `.uf2` 會以 `Read-only file system` 失敗，故改用 picotool（`brew install picotool`）。舊環境仍可拖放。
   ⚠ **端點防護（Jamf EDR 等）會擋 picotool 的「軟體進 BOOTSEL」**：`picotool reboot -f -u` / `picotool load -f` 會回報「no accessible RP-series devices in BOOTSEL mode」，裝置一直回到序列埠、`RPI-RP2` 也不掛載。此時**改用實體按鈕進 BOOTSEL**（上行步驟 1），再跑不帶 `-f` 的 `picotool load -x <uf2>`。在未裝 EDR 的機器上軟體燒錄即可。
1. 接線見 `docs/2nd-screen.md`（DI/CLK/CS/GND 四條，被動高阻抗）。
1. 讀取：`python3 poc/host/usb_probe.py --read`——自動找出 RP2040 序列埠並印出韌體輸出。新版 binary 串流由 `usb_probe.py` 解碼成 hex 並列出狀態；每 250 ms 有 heartbeat，SPI 活動才有 payload。完整原始 binary 擷取請用 `live_mirror.py --capture`。板子狀態不明時先跑不帶參數的 `usb_probe.py`（回報 BOOTSEL／RUNNING／ABSENT）。

## 接線提醒

- `spi_tap.c` 的 `PIN_DI / PIN_CLK / PIN_CS` ＝ **GP10 / GP11 / GP12**，對應 Feather 絲印 **D10 / D11 / D12**（三支相鄰純數位腳，無特殊功能、無板上上拉，適合被動搭線）。DI 與 CLK 必須相鄰。
  - ⚠ Feather 的「Dn」絲印 ≠ GPIO 編號（D4=GP6、D5=GP7、D6=GP8…）；且 **GP4 未接出**（＝USBBOOT），**GP2/GP3 是 SDA/SCL**（I2C/STEMMA，可能帶上拉，被動搭線避開）。依 Adafruit 原理圖校正。
- RP2040 輸入門檻約 2.0V：若評估板為 1.8V 訊號需加電平轉換（本 PoC 實測 1.8V 仍可讀，見 `docs/2nd-screen.md`）。
- 預設 SPI mode 0；實測極性不同就改 `.pio` 裡 `wait` 的邊緣。
