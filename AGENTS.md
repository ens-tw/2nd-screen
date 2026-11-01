# AGENTS.md

## Project Overview

**2nd-screen** — 給 SPI 點陣顯示器加一個被動的「第二螢幕」。

一片 Feather RP2040 被動高阻抗搭在點陣顯示**評估板**的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；主機端 `live_mirror.py` 重建 framebuffer，**即時**把評估板當下顯示的畫面鏡像成第二螢幕（終端裡的 ASCII，概念上也可再推到一塊實體 OLED）。

現有探針全程**只讀、不驅動任何線**，所以它在評估板毫不知情下複製畫面。這既是「替任何點陣顯示器外掛一個第二螢幕」的小工具。另允許研究在自有評估板上主動改寫第一螢幕；這需要另行確認硬體與匯流排控制權，不代表現有並接探針已能回寫。

- 目標是**自有的點陣顯示評估板**；本 repo 以「畫面 → 第二螢幕」的像素鏡像為主，也可做有明確硬體前提的第一螢幕回寫實驗。
- 顯示打包假設一般點陣 OLED 控制器的「欄定址＋每欄 8 垂直像素」佈局。

## Setup

無套件相依。

- 主機端（第二螢幕／檢視）：Python 3 標準庫即可（`poc/host/*.py`），不需 venv。
- 韌體建置：`arm-none-eabi-gcc`、`cmake`、`ninja`、pico-sdk（`~/pico-sdk`，含 `lib/tinyusb` submodule）。
- 燒錄：`picotool`（`brew install picotool`）。

## Architecture

- `docs/2nd-screen.md`：主文件——量測與真機結果、接線、資料率模型、重建方法、即時第二螢幕、demo 腳本。
- `poc/rp2040-spi-tap/`：RP2040 被動擷取韌體。
  - `spi_tap.c` / `.pio`：PIO 以 CS 為 frame 邊界、CLK 邊緣取樣 DI，連續 DMA ring 收進緩衝、USB CDC 以 STP2 binary 串流（有 CRC／序號／loss epoch）。
  - `bus_probe.c`：無示波器診斷——PWM 硬體計 CLK 上升緣，用真輸入門檻判斷「這條匯流排讀不讀得到」。
  - `display_write_test.c`：獨立的主動單次回寫韌體，USB 收完整且 CRC 正確的 frame 才啟用輸出，完成後回到輸入；硬體前提與操作見 `poc/rp2040-spi-tap/display-write-test.md`，不可直接套用被動並接線路。
  - `loopback_test.c`：on-chip 自測（同板自驅自讀），驗證擷取鏈；不可在接著目標板時燒（它會驅動腳位）。
  - `CMakeLists.txt`、`wiring.html`、`ref/`（Feather 腳位定位圖）。
- `poc/host/`：主機端工具（純標準庫）。
  - `live_mirror.py`：**即時第二螢幕（主效果）**——串流重建、終端原地重繪成 ASCII 畫面。
  - `raster.py`：單張靜態檢視（把一個擷取檔重建成一張畫面）。
  - `usb_probe.py`：找 RP2040、回報 BOOTSEL／RUNNING／ABSENT、`--read` 讀韌體輸出。
  - `make_test_frame.py` / `send_frame.py`：本機字型產圖（需 ImageMagick）／手動送一張 frame 至專用 `display_write_test`；送圖不會自動燒錄，也不做自動重試。
- `poc/lima/pico.yaml`：RP2040 工具鏈 VM（替代方案；本機已可直接 host build，見 README）。

## Conventions

- `spi_tap` / `bus_probe` 維持被動擷取：GP10/GP11/GP12 為輸入，保留 OEOVER 與 pad OD 防驅動鎖。主動回寫應另設明確命名的韌體 target 與接線文件，不由被動工具自動切換。
- 允許設計與實作自有評估板的主動顯示實驗；在接板驅動前，須確認原控制器已釋放相關輸出，或有 mux／具輸出使能的 buffer 隔離，並確認邏輯電壓、D/C（或等效命令／資料 framing）、SPI timing 與交還控制權的方式。CS 高或一段時間無 CLK 邊緣不等於原控制器已呈高阻抗，也不構成匯流排仲裁。
- 未確認上述硬體條件時，可做離線分析、文件與建置。可依使用者授權燒錄開機、USB 連線及 `HELLO` 都保持高阻抗、只在手動送圖命令後才驅動的 `display_write_test`；燒錄不代表已符合回寫條件，傳送 frame 前仍須確認上述硬體條件。會自動驅動腳位的韌體（如 `loopback_test`）只在與目標板斷開時使用。
- 事實標記為 **[證實]**／**[推測]**／**[待驗證]**，並交代證據範圍。DC 電表讀值不直接當作數位訊號振幅；擷取成功不等於電氣規格已驗證。
- `D5 xx` 的 SSD1306-compatible 解碼是顯示內部時脈設定，不是 SPI 時脈，也不代表 bus ownership；實際控制器仍待確認。不得把下一個參數值的預測當成可回寫的前提。

## Commands

Host build（見 README 快速開始）：

```bash
export PICO_SDK_PATH=$HOME/pico-sdk
cmake -S poc/rp2040-spi-tap -B poc/build/spi-tap -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C poc/build/spi-tap spi_tap bus_probe
picotool load -x -f poc/build/spi-tap/spi_tap.uf2
python3 poc/host/live_mirror.py          # 第二螢幕；--page 為預設頁序列模式；--file 重播擷取檔
```

- ⚠ 近期 macOS 會把 `RPI-RP2` 掛成唯讀，拖放 `.uf2` 失敗，故用 picotool。

## Work queue

`node tickets/engine/cli.mjs next`（現在該做的）、`node tickets/engine/cli.mjs list`（全部，JSON；`--text` 給終端、`view` 給網頁）。
讀板子一律用 CLI，不要 grep `tickets/board.mts`；手改 `board.mts` 後、commit 前先 `node tickets/engine/cli.mjs check`。

## Git／遠端

- 遠端 `origin`：`https://github.com/ens-tw/2nd-screen`（**private**）。
- **單人 repo，直接在 `main` 上開發並 `git push`，不開 feature 分支。**（覆寫全域「在預設分支先開分支」的預設。）
- 帳號：`enstw` 是個人帳號（`ens-tw` org 成員、有建 repo 權限），用 keyring 的 plain `gh`／`git` 即可。
- `poc/build/`、`_output/`、`__pycache__/` 不進 git，見 `.gitignore`。

## Authorizations（長跑授權）

自動化長跑可不經詢問：編輯 docs／code／tickets；在 `main` 上 commit 並 push；下載公開檔到 scratchpad（唯讀）；建置並燒錄自有 Feather RP2040（可復燒）。
