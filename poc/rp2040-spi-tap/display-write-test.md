# 第一螢幕單次回寫實驗

**[證實：本機產圖／建置／離線驗證]** 已用本機 `~/Library/Fonts/ENSFont.ttc` 的第一個字型（ENS Font Regular）產生「腦哥」。以 1024 pt 產圖、裁去外圍空白、等比縮至 128×64 並置中，亮像素範圍為 x=0..127、y=2..61：兩字合計 128×60，無裁字。framebuffer 為 1,024 B，每頁 128 B，每 byte 的 bit0 為該欄最上像素。

**[證實：2026-11-01 燒錄與 USB]** 已依使用者要求，以 `picotool load -v -x -f` 燒錄至 Feather RP2040，flash verification 通過，重開後 USB 產品名稱為 `Display Write Test`。僅送出 `HELLO`，收到 `DISPLAY_WRITE_TEST 1 DI=10 CLK=11 CS=12 DC=9`；沒有送出 `WRITE1` 或 framebuffer。程式在開機、USB 連線與 HELLO 階段保持四支 GPIO 輸入／輸出禁用。

**[待驗證：OLED 回寫]** OLED controller 型號、D/C、邏輯電壓與原控制器隔離方式須先確認；尚未傳送至 OLED。靜態畫面不等於控制器釋放輸出；本工具不提供 SPI 仲裁。現有 DI/CLK/CS/GND 並接方式不足以執行這個寫入測試。

## 硬體條件

- 使用自有評估板；原控制器須隔離或明確釋放相關輸出，才能讓 RP2040 獨占 OLED 介面。
- 確認 OLED 的實際訊號電壓與容限；本韌體輸出為 3.3 V，若不相容須先設置適當電平轉換。
- 保留 GP10 → OLED DI、GP11 → CLK、GP12 → CS、GND 共地；另接 **Feather D9 / GP9 → OLED D/C**。D/C 必須與資料線一樣由實驗端取得獨占控制，不可直接與仍在驅動的原控制器輸出相接。
- OLED 已完成初始化且啟用顯示。CS 在 RP2040 回到高阻抗時須由合適的上拉（拉至 OLED 邏輯電源）或交接後的控制器保持不選取；不要讓 CS／CLK 浮動。接線變更時關閉電源。

這是條件式 SSD1306-compatible、4-wire SPI 寫入方案，不支援未確認的 9-bit framing。它不包含 mux 控制或原控制器交接流程，也不自動初始化／復原顯示設定；先確認原控制器型號與模式，再用於該板。

## 產生並檢查圖檔（不接硬體即可執行）

在 repo 根目錄執行；需已安裝的 ImageMagick，不需 Python 套件：

```bash
python3 poc/host/make_test_frame.py
python3 poc/host/send_frame.py --dry-run
```

產物位於忽略版控的 `_output/write-test/`：

- `naoge.png` / `naoge.preview.png`：原尺寸與 8 倍整數放大預覽。
- `naoge.bin`：1,024 B 像素資料，不含命令。
- `naoge.replay.hex`：合成的 `B0..B7 + 128 B/page` 鏡像重播輸入，**不是可直接送上實體 SPI 的傳輸檔**。
- `naoge.transactions.json`：候選命令／資料序列與 D/C 值，需另處理 CS／時序。
- `naoge.json`：字型路徑與雜湊、像素範圍、frame 雜湊；字型本身不複製到 repo。

可用 `python3 poc/host/live_mirror.py --file _output/write-test/naoge.replay.hex` 離線重建。

## 建置與安裝專用韌體

USB CDC 本身支援雙向；原 `spi_tap` 只實作「擷取 → USB」。專用 `display_write_test` 加入「USB → 完整 frame 驗證 → OLED」，不修改被動 tap 的行為。此時不提供 STP2 擷取／live mirror。

```bash
export PICO_SDK_PATH=$HOME/pico-sdk
cmake -S poc/rp2040-spi-tap -B poc/build/spi-tap -G Ninja -DPICO_BOARD=adafruit_feather_rp2040
ninja -C poc/build/spi-tap display_write_test
```

安裝此專用韌體不會在開機、USB 連線或 HELLO 時驅動顯示線路；真正輸出仍須符合上節硬體條件並收到完整送圖命令。可用實體按鈕進入 BOOTSEL，再安裝：

```bash
picotool load -x poc/build/spi-tap/display_write_test.uf2
```

若目前韌體支援軟體 BOOTSEL，可使用 `picotool load -v -x -f poc/build/spi-tap/display_write_test.uf2` 同時燒錄、驗證與啟動；本次已用此方式完成。

在兩邊關機時完成實驗接線；先開 Feather USB，再啟用 OLED 評估板。若原控制器負責初始化，須在初始化後、開始本測試前，依實際硬體完成隔離／交接。保持靜態畫面可減少後續覆寫，但不能替代隔離。

## 手動送出一次

停掉其他讀取相同序列埠的工具。硬體與韌體就緒後執行：

```bash
python3 poc/host/send_frame.py
```

程式只自動選取唯一名稱含 `Display Write Test` 的 RP2040；若平台無法辨識產品名，明確指定序列埠：

```bash
python3 poc/host/send_frame.py _output/write-test/naoge.bin --port /dev/cu.usbmodemXXXX
```

USB 流程為 `HELLO` 核對韌體與固定腳位，再送一個 `WRITE1 <CRC32> <2048 hex digits>` 命令。韌體收到完整換行、確認長度／hex／CRC 才驅動輸出。SPI 使用 mode 0、MSB-first、每半週期至少 5 µs（不高於約 100 kHz），傳送：

1. D/C=0：`20 02` 選擇 page addressing。
2. 每頁 D/C=0：`B0..B7 00 10` 設定頁與 column 0。
3. 每頁 D/C=1：128 B 像素；每段傳輸前後控制 CS。
4. 全部完成後 CS 拉高，四支腳回到輸入，重新鎖住 OEOVER／pad OD；回報 `DONE 1024 <CRC32> HIGH_Z`。

上述命令依 [SSD1306 datasheet §10.1.1–10.1.3](https://www.orientdisplay.com/wp-content/uploads/2020/11/SSD1306.pdf#page=34)。不改動 `D5` oscillator、contrast、power 或 scan direction；不用預測下一個頻率 byte。若控制器型號／欄偏移不符，必須調整此候選序列。

`DONE` 只證明韌體已送出時脈與資料，不代表 OLED 已接受或顯示正確。回覆遺失時程式報告結果不確定，**不會自動重送**；先目視檢查再決定是否重跑。原控制器後續更新仍可能覆寫實驗畫面。

## 回到鏡像

在斷開目標板後，以 BOOTSEL 安裝回 `poc/build/spi-tap/spi_tap.uf2`，關機後還原被動四線接法，再依原順序上電。重新接回原控制器時須恢復正確的顯示／定址狀態；必要時由評估板重新初始化。

**驗證範圍：** 本機 8,192 像素 packing round-trip 與合成鏡像解碼一致；host 測試含 USB pseudo-terminal、錯誤韌體、遺失 ACK 不重試、dry-run 不開裝置，以及原生 C parser 的完整／截斷／損壞請求。RP2040 UF2 已建置並燒錄，flash verification 與真板 USB HELLO 通過；實體 OLED 電氣與畫面結果尚未測試。
