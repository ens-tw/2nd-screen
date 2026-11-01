# AGENTS.md

## Project Overview

**2nd-screen** — 給 SPI 點陣顯示器加一個被動的「第二螢幕」。

一片 Feather RP2040 被動高阻抗搭在點陣顯示**評估板**的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；主機端 `live_mirror.py` 重建 framebuffer，**即時**把評估板當下顯示的畫面鏡像成第二螢幕（終端裡的 ASCII，概念上也可再推到一塊實體 OLED）。

現有探針全程**只讀、不驅動任何線**，所以它在評估板毫不知情下複製畫面。這是「替任何點陣顯示器外掛一個第二螢幕」的小工具。

- 目標是**自有的點陣顯示評估板**；本 repo 只做「畫面 → 第二螢幕」的被動像素鏡像。
- 顯示打包假設一般點陣 OLED 控制器的「欄定址＋每欄 8 垂直像素」佈局。

## Setup

無套件相依。

- 主機端（第二螢幕／檢視）：Python 3 標準庫即可（`poc/host/*.py`），不需 venv。
- 韌體建置：`arm-none-eabi-gcc`、`cmake`、`ninja`、pico-sdk（`~/pico-sdk`，含 `lib/tinyusb` submodule）。
- 燒錄：`picotool`（`brew install picotool`）。

## Architecture

- `docs/2nd-screen.md`：主文件——量測與真機結果、接線、資料率模型、重建方法、即時第二螢幕、串流格式、demo 腳本。
- `docs/bluefruit-ble.md`：BLE 開發資料（規格、吞吐量證據、實測計畫）；bridge 尚未實作。
- `poc/rp2040-spi-tap/`：RP2040 被動擷取韌體。
  - `spi_tap.c` / `.pio`：PIO 以 CS 為 frame 邊界、CLK 邊緣取樣 DI，連續 DMA ring 收進緩衝，bus 閒置 2 ms 就經 USB CDC 送一包（控制指令與 frame 同包）。封包格式與量測見主文件「連續串流韌體」。
  - `bus_probe.c`：無示波器診斷——PWM 硬體計 CLK 上升緣，用真輸入門檻判斷「這條匯流排讀不讀得到」。
  - `CMakeLists.txt`、`wiring.html`、`ref/`（Feather 腳位定位圖）。
- `poc/host/`：主機端工具（純標準庫）。
  - `live_mirror.py`：**即時第二螢幕（主效果）**——串流重建、終端原地重繪成 ASCII 畫面。
    - status bar 的壓縮與流量欄位定義見主文件「連續串流韌體」。開埠須用 `TCSANOW`，否則會丟掉 session-start status。
  - `raster.py`：共用的 framebuffer → ASCII 繪製函式。
  - `usb_probe.py`：找 RP2040、回報 BOOTSEL／RUNNING／ABSENT、`--read` 讀韌體輸出。
- `poc/lima/pico.yaml`：RP2040 工具鏈 VM（替代方案；本機已可直接 host build，見 README）。

## Conventions

- 只做被動擷取：`spi_tap` / `bus_probe` 的 GP10/GP11/GP12 為輸入，保留 OEOVER 與 pad OD 防驅動鎖。主動回寫路線已由使用者決定移除（2026-11-02），不實作；舊實作見 commit `5e7149b`。
- 事實標記為 **[證實]**／**[推測]**／**[待驗證]**，並交代證據範圍。DC 電表讀值不直接當作數位訊號振幅；擷取成功不等於電氣規格已驗證。
- 使用者確認的接點標示為 `+5V vUSB / GND / ON / CS / CLK / D1`；`+5V` 與 `ON`（用途未確認）都不接。四線不含 D/C，重建靠完整八頁序列定位。
- `D5 xx` 的 SSD1306-compatible 解碼是顯示內部時脈設定，不是 SPI 時脈；實際控制器型號未確認。
- 文件更新：改寫原條目，不追加逐輪紀錄。每項能力只留目前有效的結果與證據路徑；被取代的量測靠 commit 歷史查。未完成工作進 work queue，不寫在文件裡當待辦。文件引用的 `_output/` 檔不進 git，刪檔前先改引用。

## Commands

Host build（見 README 快速開始）：

```bash
export PICO_SDK_PATH=$HOME/pico-sdk
cmake -S poc/rp2040-spi-tap -B poc/build/spi-tap -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C poc/build/spi-tap spi_tap bus_probe
picotool load -x -f poc/build/spi-tap/spi_tap.uf2
python3 poc/host/live_mirror.py          # 第二螢幕；--page 為預設頁序列模式；--file 重播擷取檔
```

- host 測試：`python3 -m unittest discover -s poc/host -p 'test_*.py'`。
- ⚠ 近期 macOS 會把 `RPI-RP2` 掛成唯讀，拖放 `.uf2` 失敗，故用 picotool。

## Work queue

`node tickets/engine/cli.mjs next`（現在該做的）、`node tickets/engine/cli.mjs list`（全部，JSON；`--text` 給終端、`view` 給網頁）。
讀板子一律用 CLI，不要 grep `tickets/board.mts`；手改 `board.mts` 後、commit 前先 `node tickets/engine/cli.mjs check`。

## Git／遠端

- 遠端 `origin`：`https://github.com/ens-tw/2nd-screen`（**private**）。
- **單人 repo，直接在 `main` 上開發並 `git push`，不開 feature 分支。**（覆寫全域「在預設分支先開分支」的預設。）
- 帳號：`enstw` 是個人帳號（`ens-tw` org 成員、有建 repo 權限），用 keyring 的 plain `gh`／`git` 即可。
- `poc/build/`、`_output/`、`__pycache__/` 不進 git，見 `.gitignore`。

## Authorizations

- 自動化長跑可不經詢問：編輯 docs／code／tickets；在 `main` 上 commit 並 push；下載公開檔到 scratchpad（唯讀）；建置韌體。
- 燒錄自有 Feather RP2040 不需再詢問，不限長跑（使用者授權，2026-11-02）。序列埠若有其他 reader，不代為終止。
