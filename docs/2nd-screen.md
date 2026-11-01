# 2nd-screen — 被動把點陣顯示匯流排鏡到第二螢幕

一片 Feather RP2040 被動高阻抗搭在點陣顯示**評估板**的「控制器 → OLED」SPI 匯流排上（四條線：DI/CLK/CS/GND），把匯流排位元組串流回主機；主機端把它重建成 framebuffer，即時鏡像成評估板的**第二螢幕**。

探針全程**只讀、不驅動任何線**。這既是「替點陣顯示器外掛第二螢幕」的小工具。

## 範圍

- 高阻抗被動擷取 控制器→OLED 的 SPI
- 把位元組流重建成畫面，鏡成第二螢幕

## 安全護欄

1. 探針被動、只讀、不回寫、不接 MISO；唯一共用的電源連線是 `GND`（**不接 +5V**，避免回灌燒件）。
1. RP2040 先 USB 通電再搭線（永不把活匯流排灌進未通電晶片）。

## 接線（被動、高阻抗）

只接四條，GPIO 全設輸入，不驅動任何線。

```mermaid
flowchart LR
  subgraph Board[點陣顯示評估板]
    CTRL[顯示控制器] -- SPI --> OLED[OLED 點陣螢幕]
    TP[(測試點<br>CS · CLK · DI · GND)]
    CTRL -.同一組訊號.- TP
  end
  subgraph Probe[Feather RP2040 被動探針]
    G[GPIO 輸入<br>高阻抗]
    PIO[PIO 擷取] --> DMA[DMA → RAM 緩衝]
  end
  TP -- CLK --> G
  TP -- DI/DATA --> G
  TP -- CS --> G
  TP -- GND --> G
  G --> PIO
```

| 訊號 | RP2040 GPIO | Feather 絲印 | 作用 |
|---|---|---|---|
| DI（資料） | GP10 | D10 | IN base |
| CLK（時脈） | GP11 | D11 | IN base + 1（必須與 DI 相鄰） |
| CS（選擇） | GP12 | D12 | frame 邊界（低電位有效） |
| GND | GND | GND | 共地（唯一共用電源線） |

> ⚠ Feather 的「Dn」絲印 ≠ GPIO 編號；GP4 未接出（USBBOOT），GP2/GP3 是 SDA/SCL（可能帶上拉，避開）。選 D10/D11/D12 三支相鄰純數位腳。評估板側的測試點依該板資料手冊／原理圖定位，接前用電表復驗（GND 導通、上電量各點對地電壓辨識訊號線）。

## 擷取端韌體（RP2040 PIO tap）

RP2040 的 PIO：以 CS 為 frame 邊界、在 CLK 取樣邊緣讀 DI，湊成位元組推 FIFO，再 DMA 進緩衝，不占 CPU。

```
; PIO 骨架（概念）：CS 低電位期間，於 CLK 上升緣取樣 DI
.program spi_tap
    wait 0 pin CS          ; 等 CS 拉低（frame 開始）
sample:
    wait 1 pin CLK         ; 等時脈上升緣
    in   pins, 1           ; 取樣 DI 一個位元
    wait 0 pin CLK         ; 等時脈回落
    jmp  sample
```

`spi_tap.c` 把三支探針腳全設輸入、以 OEOVER/OD 硬體鎖成永不驅動（純被動），DMA 收滿一塊（預設 2048 B，低延遲）就經 USB CDC 以 hex 倒出。預設 SPI mode 0；實測極性不同就改 `.pio` 的 `wait` 邊緣。

### 擷取鏈自測（P-1，晶片內 loopback，無外接跳線）

接真評估板前，先確認**擷取鏈本身是對的**（PIO 取樣 ＋ DMA ＋ USB CDC）。做法是同一顆 RP2040「自己驅動、自己擷取同一組腳」，不接跳線、不接目標板：

- `loopback_test.c` 用 **SIO（一般 GPIO 輸出）** 在 GP10/11/12 打一組已知 mode-0 波形（第 _i_ 個位元組 = `i & 0xFF`），再用**與正式韌體同一支** `spi_tap.pio` 把同一組腳當輸入讀回、比對。
- 關鍵事實：RP2040 的 **PIO 輸入永遠接在 pad 的輸入同步器上，與輸出 FUNCSEL 無關**，故 SIO 驅動輸出、PIO 讀輸入可在晶片內 loopback，毋需外部跳線。
- ⚠ `loopback_test` 會把腳設成**輸出**，**絕不可**在接著目標板時燒；只有 `bus_probe` 與 `spi_tap` 是被動的。

```bash
ninja -C poc/build/spi-tap loopback_test
picotool load -x -f poc/build/spi-tap/loopback_test.uf2
python3 poc/host/usb_probe.py --read 8
```

**實測（Feather RP2040，本機）**[證實]：連續多 round 全 `PASS`，每 round **16384/16384 位元組零不符**，擷取開頭 `00 01 02 … 1f`，與驅動端一致。

```
# loopback_test ready (DI=GP10 CLK=GP11 CS=GP12) — on-chip self-test, no jumper
round 0: PASS  (0/16384 bytes mismatch)
  head: 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f
```

結論：**PIO 取樣（mode-0、CS 為 frame 邊界、MSB-first autopush）＋ DMA ＋ USB CDC 這條擷取鏈端到端正確。** 自測後重燒回 `spi_tap.uf2`。

<!-- answer: P-1 -->

## 主機端重建：第二螢幕

位元組流依一般點陣 OLED 控制器的「欄定址＋每欄 8 垂直像素」佈局重建 128×64 framebuffer，印成半格 ASCII。

- `live_mirror.py`：**即時第二螢幕**——邊收串流邊重建，終端原地重繪；預設等待完整 `B0..B7` 頁序列（`--page` 同義），`--raw` 顯示最新 1024 B 的未對齊診斷畫面；`--file <cap>` 重播擷取檔。
- `raster.py`：把單一擷取檔還原成一張靜態畫面。

> ⚠ 四線（DI/CLK/CS/GND）**不含 D/C（資料／命令）線**，故位元組流中命令與像素未硬分。**[證實：程式檢查]** 舊版非零密度搜尋無法確認左上角，舊版 `--page` 亦可能跳過頁首低值像素。現版改以完整八頁序列核對位置，不再依像素密度選幀，也不跳過頁首像素。這仍是以已觀察格式重建；面板實際起點與顯示方向尚須對照確認。

**[證實：2026-11-01 裝置擷取與重播]** 本機 `_output/screen1/device-sample-01.txt` 共 96,256 B 匯流排資料，分為 47 個 2048 B dump。逐區塊獨立掃描得到 47 組完整序列：`B0 + 128 B`、`B1 + 128 B`，依此至 `B7 + 128 B`；每頁 marker 相距 129 B。以這個樣本修正：

- 只收整行 1–32 bytes 的偶數長度 hex，忽略 banner／狀態文字。
- 收到完整八頁才更新；新空白畫面可取代舊畫面，不再偏好舊的高密度畫面。
- 不將孤立 `0xBn` 當頁起點，不跳過 `0x00`、`0x10` 等有效像素。
- 空行表示 firmware dump 邊界；不跨邊界拼幀，保留上一個完整畫面直到取得新幀。資料相同時不重繪。

**[限制]** 此格式不涵蓋只有局部頁更新或插入欄命令的其他協定。韌體傾印時停止擷取，可能漏掉某次畫面；主機修正不能補回漏掉的 bytes。完整 framebuffer 的頁／欄起點已依捕獲序列定位，與照片的精確像素對齊仍待確認。

### 保留被篩掉的資料與時間資訊

**[證實：程式與回歸測試]** `live_mirror.py` 即時執行時，預設將收到的每個 serial chunk **先存檔，再解析**，存至 `_output/captures/mirror-<UTC>-<unique>.txt`。含 banner、空行、不合 hex 格式的內容，以及退出時未收完一行的 bytes；不是終端 ASCII 畫面截圖。可以指定檔名（不覆寫既有檔案）：

```bash
# 分別記錄左右移動游標、screensaver 喚醒兩個情境；Ctrl-C 結束並完成紀錄。
python3 poc/host/live_mirror.py --capture _output/pin-cursor-01.txt
python3 poc/host/live_mirror.py --capture _output/screensaver-wake-01.txt

# 替舊的原始擷取建立相同診斷紀錄，輸出新檔並保留來源。
python3 poc/host/live_mirror.py --file _output/pin-cursor-01.txt \
  --capture _output/pin-cursor-reviewed-01.txt
```

旁邊的 `<capture>.events.jsonl` 記錄：serial chunk 的檔案 offset／長度／主機相對時間、完整 frame 的匯流排 offset、實際 render 時間，以及在 dump 邊界、buffer 裁切、退出時**未用於完整 frame 的所有 bus bytes**（`unmatched_bus_bytes`，含 `hex`、`bus_offset`、`reason`）。不將這些 bytes 一律判成雜訊或命令；可能包含初始化、其他協定或被截斷的畫面。`non-hex-line` 與 `partial_serial_line` 另留原始 bytes。檔案與事件逐次 flush；收到完整畫面以前亦會存檔。重播紀錄的 `source` 為 `replay`，其時間代表重播速度，不能當成原始擷取時間。

**[證實：程式檢查]** firmware 仍等待 2048 B 收滿才送出，且 USB 傾印期間停止 PIO。單次全畫面約 1039 B（含 frame 前綴），可能留在尚未滿的 buffer 裡；主機紀錄只能保存 firmware 實際送達的資料。先前 47 個 dump 各只有一個完整八頁序列，與「約半數更新能鏡像」的觀察相符；**[推測]** 游標／喚醒漏鏡像可能來自等待收滿或漏擷取，尚不能認定為局部更新。終端重繪上限已由約 6.7 Hz 提高為 30 Hz；這不會補回 firmware 沒送出的資料。下一步宜先驗證持續 DMA 擷取、短週期送出及 overflow 計數，再決定是否需要局部更新解碼。

### 用照片建立像素參考，再核對 SPI 起點

**[證實：2026-11-01 本機轉換]** `~/Downloads/screen1.heic` 可取樣成 128×64 的視覺參考，匯出 1024 B 垂直欄打包資料。**[推測]** 此照片的格距約為 `(18.25, 18.15)` 個照片像素，帶輕微傾斜；以下 origin 是候選畫布 `(0,0)` 的像素中心，**不是已確認的面板左上角**。照片無清楚的面板邊界，黑色邊界仍有整數像素位移的不確定性。

```bash
# HEIC/PNG 等格式用本機 ImageMagick 解碼；若輸入 8-bit binary PGM 則只需標準庫。
python3 poc/host/photo_reference.py ~/Downloads/screen1.heic \
  --out _output/screen1/reference \
  --origin 458.85 130.38 --pitch 18.25 18.15 --shear=-0.004

# reference.hex 可直接交給既有靜態檢視器。
python3 poc/host/raster.py _output/screen1/reference.hex

# 用「同一個畫面」的真實擷取核對各頁的候選資料起點。
python3 poc/host/compare_reference.py capture.txt _output/screen1/reference.bin \
  --mask _output/screen1/reference.mask.bin > _output/screen1/comparison.json
```

輸出 `.bits.txt` 每行為從左到右的 128 個像素，共 64 行；`.bin` / `.hex` 的位址是 `page*128+x`，bit 0 為該頁最上列。它是**預期像素參考**，不含命令，也不宣稱是實測的線上位元順序。`.pbm` / `.preview.pgm` 供目視檢查，`.json` 記錄來源雜湊與取樣參數；`.mask.bin` 排除亮度不確定的像素，但不代表幾何位置已確認。照片及衍生檔留在忽略版控的 `_output/`。

比較工具以遮罩後的像素 Hamming distance 排出每頁候選位址，附前後各 8 B 以查找頁／欄命令；位址單位是解碼後的**匯流排 bytes**。頁面各自比對，可能來自不同重繪，不能僅憑最低誤差就宣稱鎖定一個完整 frame。可用 `--shift-x N --shift-y N` 檢驗照片黑邊的候選位移；平移新露出的像素不參與比對。

**[待驗證]** 已收到裝置 SPI 樣本並依頁序列修正同步規則；照片參考與同一畫面的精確比對、欄偏移與面板顯示方向仍待確認。`spi_tap.c` 現有每 2048 B 停止 SM 傾印的行為亦可能漏資料（程式註解已說明），不能將所有相鄰 USB 區塊一律視為無縫匯流排。

驗證工具：`python3 -m unittest discover -s poc/host -p 'test_*.py' -v`（含鏡像與照片參考的回歸測試）。

## 量測與真機結果

沒有示波器也能定案：`bus_probe.c` 讓 RP2040 用**真正的輸入門檻**硬體計 CLK 上升緣——「數得到邊緣」直接等於「正式 tap 讀得到」。純被動，可安全搭在活匯流排上。每秒一行：`# alive  CLK rising/s=<n> (total=<n>)  sample DI=<0/1> CLK=<0/1> CS=<0/1>`。

**量測記錄**（bus_probe + spi_tap，評估板）

| 量測 | 值 | 備註 |
|---|---|---|
| CS 對地（DC 電表） | `3.6V`[證實] | idle-high |
| CLK 對地（DC 電表） | `1.8V`[證實] | 1.8V 訊號 |
| `sample CS`（開機、靜態） | `1`[證實] | idle-high，證明探針有接、共地正常 |
| `CLK rising/s`：靜態畫面 | `0`[證實] | write-on-change：靜態不 clocking |
| `CLK rising/s`：切換畫面 | `8312`/重繪（峰 `16624`）[證實] | 每次重繪一突發，total 單調累積 2.03M→2.18M |
| 真擷取（spi_tap，切畫面 32s） | `12,480 B`[證實] | 垂直欄打包；`raster.py` 還原出可辨識畫面字形 |

**實跑經過**（host build：`brew install picotool ninja`、`~/pico-sdk` shallow clone + tinyusb、cmake/ninja；`picotool load -x -f` 軟體進 BOOTSEL 成功）：

1. **評估板關機時**：三線恆 0、零邊緣——因匯流排無人驅動（非接線問題）。排除接線假設的關鍵：開機後 `sample CS` 立刻讀到 `1`。
2. **評估板開機**：靜態 `rising/s=0`、`CS=1`；切畫面時 `rising/s` 跳到 **8312/重繪**（峰 16624），`total` 單調累積。**結論：1.8V CLK 跨得過 RP2040 門檻、讀得到；且為 write-on-change。** 每次重繪約 8312 邊緣 ≈ 一張 128×64 全畫面（8192 bit）。**→ 不需電平轉換。**
3. **真擷取**：block 由 16384 調小到 2048 B（bench／第二螢幕低延遲），切畫面擷得 **12,480 B** 原始垂直欄像素，`raster.py` 以 128 欄 × 頁重繪，**肉眼可讀出評估板畫面字形**——被動搭四線即可即時旁觀顯示內容，**於真機證實**。

| 觀察到 | 結論 |
|---|---|
| 切畫面時 `rising/s` **跳起來**、靜態歸零 | 讀得到，且為 write-on-change（→ 第二螢幕可行） |
| 畫面更新但 `rising/s` **一直 0** | 準位太低（1.8V < V_IH）或接觸問題 → 加電平轉換/比較器 |
| 靜態也**持續很高** | 連續刷新（無 GDDRAM）→ 改連續資料率模型 |

<!-- answer: P-2 -->
<!-- answer: P-4 -->

## 資料率與刷新模型

只搭到「控制器寫入」這一種流量；面板自身的連續掃描在控制器內部，不上 SPI 線。本機實測為 **write-on-change**（靜態 `rising/s=0`，切畫面才突發）——即控制器自帶顯示記憶體（GDDRAM）：

- 一張全幀 128×64 ＝ 1024 B 像素 ＋ 少量頁指令 ≈ **~1 KB**，與實測「每次重繪約 8312 邊緣 ≈ 8192 bit」相符。
- 其餘時間匯流排閒置；真機若為局部更新（只重畫變動區），每次突發只會**更小**——第二螢幕只會更輕鬆。
- 取樣餘裕：PIO 可達 sysclk（125 MHz），對上幾 MHz 的匯流排遠非瓶頸。


<!-- answer: P-5 -->
