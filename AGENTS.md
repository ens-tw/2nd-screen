# AGENTS.md

## Project Overview

**2nd-screen** — 給 SPI 點陣顯示器加一個被動的「第二螢幕」。

一片 Feather RP2040 被動高阻抗搭在點陣顯示**評估板**的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；主機端 `live_mirror.py` 重建 framebuffer，**即時**把評估板當下顯示的畫面鏡像成第二螢幕（終端裡的 ASCII，概念上也可再推到一塊實體 OLED）。

探針全程**只讀、不驅動任何線**，所以它在評估板毫不知情下複製畫面。這既是「替任何點陣顯示器外掛一個第二螢幕」的小工具，也順帶說明一件事：**可及的明文顯示匯流排，內容就守不住**。

- 目標是**自有的點陣顯示評估板**；本 repo 不針對任何特定商品，也不含任何內容解讀（OCR／文字還原）邏輯——只做「畫面 → 第二螢幕」的像素鏡像。
- 顯示打包假設一般點陣 OLED 控制器的「欄定址＋每欄 8 垂直像素」佈局。

## Setup

無套件相依。

- 主機端（第二螢幕／檢視）：Python 3 標準庫即可（`poc/host/*.py`），不需 venv。
- 韌體建置：`arm-none-eabi-gcc`、`cmake`、`ninja`、pico-sdk（`~/pico-sdk`，含 `lib/tinyusb` submodule）。
- 燒錄：`picotool`（`brew install picotool`）。

## Architecture

- `docs/2nd-screen.md`：主文件——量測與真機結果、接線、資料率模型、重建方法、即時第二螢幕、demo 腳本。
- `poc/rp2040-spi-tap/`：RP2040 被動擷取韌體。
  - `spi_tap.c` / `.pio`：PIO 以 CS 為 frame 邊界、CLK 邊緣取樣 DI，DMA 收進緩衝、USB CDC 以 hex 倒出。
  - `bus_probe.c`：無示波器診斷——PWM 硬體計 CLK 上升緣，用真輸入門檻判斷「這條匯流排讀不讀得到」。
  - `loopback_test.c`：on-chip 自測（同板自驅自讀），驗證擷取鏈；**絕不可**在接著目標板時燒（它會驅動腳位）。
  - `CMakeLists.txt`、`wiring.html`、`ref/`（Feather 腳位定位圖）。
- `poc/host/`：主機端工具（純標準庫）。
  - `live_mirror.py`：**即時第二螢幕（主效果）**——串流重建、終端原地重繪成 ASCII 畫面。
  - `raster.py`：單張靜態檢視（把一個擷取檔重建成一張畫面）。
  - `usb_probe.py`：找 RP2040、回報 BOOTSEL／RUNNING／ABSENT、`--read` 讀韌體輸出。
- `poc/lima/pico.yaml`：RP2040 工具鏈 VM（替代方案；本機已可直接 host build，見 README）。

## Conventions

- 「被動」是鐵律：擷取腳位全程輸入、以 OEOVER/OD 鎖成永不驅動；任何會驅動匯流排的韌體（如 `loopback_test`）不得在接著目標板時燒。
- 本 repo 只做像素鏡像，**不做** OCR／內容還原。要加功能前先問：這是「畫面 → 第二螢幕」嗎？不是就別加。
- 只用**自有、無敏感內容**的評估板；擷取資料不離開評估環境。
- 事實陳述附標記：**[證實]** 有實測／多方一致；**[推測]** 間接推得。圖表用 Mermaid，直接寫在 Markdown 裡。

## Commands

Host build（見 README 快速開始）：

```bash
export PICO_SDK_PATH=$HOME/pico-sdk
cmake -S poc/rp2040-spi-tap -B poc/build/spi-tap -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C poc/build/spi-tap spi_tap bus_probe
picotool load -x -f poc/build/spi-tap/spi_tap.uf2
python3 poc/host/live_mirror.py          # 第二螢幕；--page 改頁命令對齊；--file 重播擷取檔
```

- ⚠ **端點防護（Jamf EDR 等）**會擋 picotool 的「軟體進 BOOTSEL」；此時改用實體按鈕進 BOOTSEL 再跑不帶 `-f` 的 `picotool load -x`。無 EDR 機器軟體燒錄即可。
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

需暫停並列入 stop report：開 PR、任何觸及真實資產的動作、對外發佈、不可逆刪除，以及其他未涵蓋的不可逆或對外動作。
