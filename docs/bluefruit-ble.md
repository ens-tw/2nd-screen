# Bluefruit BLE 開發資料

把第二螢幕的串流從 USB 改走 BLE 前要先知道的事。接線見 [`bluefruit-wiring.html`](../poc/rp2040-spi-tap/bluefruit-wiring.html)；串流格式見主文件[連續串流韌體](2nd-screen.md#連續串流韌體)。

**現況：只有資料與接線規劃。** 橋接韌體和 BLE 接收端都還沒寫，模組也還沒接上測過。下一步是 work queue 的 P-9。

## 結論

- **9600 baud 不夠。** 模組預設 9600 8N1，上限 960 B/s；串流最忙的 30 秒要 1.43 kB/s。
- **提高 baud 官方不建議，但只有這條路不必改壓縮。** Adafruit 明寫 9600 以上 nRF51 UART 可能掉字元，所以要配 RTS/CTS 並實測。
- **BLE 本身也可能不夠。** 能找到的數字約 0.5–2.4 kB/s，而且都是 2016 年的非正式回報。串流平均勉強可過，2 秒尖峰 2.25 kB/s 已接近上緣。
- **所以先量鏈路，再決定要不要做 LZ4（P-8）。** 鏈路夠快就不必犧牲每包獨立解碼。

## 要傳多少資料

**[證實：真板擷取]** `_output/captures/mirror-20261101T164415Z-576a5b.txt`，455.6 秒、1,768 個 frame，含每包 12 B 開銷。

| 項目 | 值 |
|---|---:|
| 每 frame 線上 bytes（中位數／p95／p99／最大） | 123／221／429／452 B |
| 最短 frame 間隔（高負載，p5） | 約 103 ms |
| 最忙 30 秒 | 1.43 kB/s（約 9.67 fps） |
| 最忙 2 秒 | 2.25 kB/s |
| 閒置時 status heartbeat | 144 B/s（每秒 4 包、每包 36 B） |

數字會隨畫面內容變動，不是上限保證。

## 模組規格

Adafruit Bluefruit LE UART Friend（[產品頁](https://www.adafruit.com/product/2479)）：nRF51822 系列、Cortex-M0 16 MHz、256 KB flash、32 KB SRAM。2026-11-02 查詢時有現貨。韌體屬於 `BLEFRIEND32` 系列，[韌體 repo](https://github.com/adafruit/Adafruit_BluefruitLE_Firmware) 最高版本資料夾為 0.9.0。

| 項目 | 規格 | 來源 |
|---|---|---|
| VIN | 3.3–16 V | [pinouts](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/pinouts) |
| RXI／CTS／MOD | level shifted，可用 3–5 V | 同上 |
| TXO／RTS | 3.3 V 輸出 | 同上 |
| CTS | 預設被拉高，**接地才會往外送資料** | 同上 |
| RTS | 低電位表示可以送資料給模組 | 同上 |
| MOD | 高＝Command、低＝UART/Data；不接則由滑動開關決定 | 同上 |
| 模式切換 | 軟體送 `+++\n`；開關 CMD 位置時 LED 閃 3 下，Data 模式閃 2 下 | [command mode](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/command-mode-1)、[data mode](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/data-mode) |
| 恢復出廠 | DFU 拉低超過 5 秒，直到兩顆 LED 閃爍 | [pinouts](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/pinouts) |
| 更新韌體 | OTA，用手機 Bluefruit LE Connect app | [DFU](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/dfu-updates) |

### 會用到的 AT 指令

| 指令 | 最低韌體 | 用途與注意 | 來源 |
|---|---|---|---|
| `ATI` | 0.3.0 | 查板名、晶片、codebase、韌體版本、SoftDevice | [standard AT](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/standard-at) |
| `ATZ` | 0.3.0 | 重置；改裝置名稱後需要 | 同上 |
| `AT+BAUDRATE` | 0.7.0 | 1200–1000000（含 115200、230400、460800、921600）。官方：「不建議高於 9600，nRF51 UART 可能掉字元」。是否斷電後保留，文件沒寫 | [hardware](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/hardware) |
| `AT+UARTFLOW` | 0.7.0 | 開關 RTS/CTS，不帶參數為查詢 | 同上 |
| `AT+BLEUARTFIFO` | 0.6.7 | 查 BLE UART TX／RX FIFO 剩餘空間 | [BLE services](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/ble-services) |
| `AT+GAPGETCONN` | 0.3.0 | 是否已連線（1／0） | [BLE GAP](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/ble-gap) |
| `AT+GAPINTERVALS` | 0.3.0 | 連線間隔，最小 10 ms。官方警告改錯可能讓裝置連不上 | 同上 |
| `AT+GAPDEVNAME` | 0.3.0 | 改廣播名稱，方便辨識 | 同上 |

TX／RX FIFO 在目前的 32 KB SRAM 硬體上各為 1024 bytes（韌體 0.6.7 起）。

## BLE 服務

| 項目 | UUID | 方向 |
|---|---|---|
| UART service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | — |
| Central 寫入 | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | Mac → 模組 |
| Notify | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | 模組 → Mac，走這條 |

UUID 取自 [bleak 官方範例](https://github.com/hbldh/bleak/blob/develop/examples/uart_service.py)，service UUID 與 [Adafruit 文件](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/uart-service)一致。每個 GATT 封包最多 20 bytes。

## 吞吐量證據

**沒有找到 UART Friend 在目前韌體、經 macOS、帶 RTS/CTS 的實測。** 以下都只能當參考範圍。

| 數字 | 換算 | 條件與可信度 | 來源 |
|---|---|---|---|
| 官方理論值，每連線間隔最多 6 包 | 30 ms 間隔 4 kB/s；iOS 8.2 每間隔 3 包時 2 kB/s | 理論上限，只列 iOS，沒有 macOS | [FAQ](https://learn.adafruit.com/introducing-the-adafruit-bluefruit-le-uart-friend/faq) |
| 102,400 B／41.86 s | 2.45 kB/s | Adafruit 工程師，2016-01，0.7.0 beta。當時 Nordic app 都跟不上；討論串以 SPI 模組為主 | [論壇](https://forums.adafruit.com/viewtopic.php?t=83783&start=15) |
| 20 B／38 ms | 0.53 kB/s | 同上，同月稍早的 beta | 同上 |
| 660 字元／秒 | 0.66 kB/s | 使用者回報，0.7.0、command mode | 同上 |

**baud 只決定 UART 這段的速度。** 模組硬體 RX FIFO 為 6 bytes，剩 4 bytes 空間時就拉高 RTS（[Nordic 文件引述](https://devzone.nordicsemi.com/f/nordic-q-a/10333/how-is-the-rts-pin-controlled-in-uart-with-flowcontrol)）。baud 每加倍，FIFO 能撐的時間就減半：115200 約 521 µs，230400 約 260 µs。[論壇回覆](https://devzone.nordicsemi.com/f/nordic-q-a/5974/get-uart-error)（未標示是否為 Nordic 員工）指藍牙協定堆疊占用 CPU 最長約 6 ms，新版晶片約 240 µs，可撐到 192 kbps 不溢位。**[推測]** 這能解釋「115200 可以、230400 掉包」，也能解釋官方保守建議 9600；實際仍看晶片版本與韌體。串流尖峰只要 2.25 kB/s，38400（3.84 kB/s，FIFO 約 1.56 ms）就夠，實測應從這裡開始，不必衝高。

論壇頁會擋一般抓取，本機副本在 `_output/bluefruit-ble/forum-transfer-speed-p2.md`。

**[證實：Adafruit 工程師，同討論串]** 韌體為了不塞爆 UART FIFO 而有排隊延遲，所以模組本身會限制吞吐量；官方也說要最高速度就得直接改 nRF51822 韌體。

**連線參數由 central 決定。** 依 [Silicon Labs 整理的 Apple 規範](https://docs.silabs.com/mobile-apps/3.3.2/mobile-apps-suitable-connection-parameters/)，Apple 裝置最小連線間隔為 15 ms，周邊只能請求、central 可拒絕。該文只談 iOS，**macOS 的實際間隔未知**，要實測。

## 接收端（Mac）

- **函式庫：** [bleak](https://bleak.readthedocs.io/en/latest/backends/macos.html)。**[證實：本機]** bleak 3.0.2 可在這台 Mac 的 Python 3.13 與 3.15 安裝並匯入；尚未實際連線。
- **相依例外：** 這會打破 `poc/host` 只用標準庫的慣例。建議獨立成 PEP 723 腳本用 `uv run` 執行，`live_mirror.py` 維持無相依。
- **macOS 定址：** CoreBluetooth 用系統配發的 UUID，不是 MAC 位址，而且只在掃描過的那台 Mac 有效。程式應以 service UUID 或裝置名稱掃描。
- **權限：** 第一次使用 Bluetooth 時系統會跳視窗詢問，拒絕後會一直拋 `BleakBluetoothNotAvailableError`，只能到「系統設定 → 隱私權與安全性 → 藍牙」修改。終端機 app 的情況文件沒寫，要實測。
- **重用解析器：** `StreamParser.feed` 本來就接受任意切塊，20 B 的 notification 可以直接餵。bleak 是 async，現在的 `select` 迴圈要改用 queue 接。

## 橋接韌體會碰到的問題

現在的 `spi_tap.c` 只考慮 USB，改 UART 要處理：

1. **沒有 DTR：** 目前靠 `tud_cdc_connected()` 判斷 session 並送開頭 status，UART 沒有對應訊號。接收端晚連上會收不到 status，所以要定期送，例如每秒一包（36 B/s）。
2. **data 包不帶 epoch／drop：** 接收端沒看過 status 時，狀態暫時視為 0，下一包 status 會觸發一次假的 gap，只影響當下未完成的 frame。
3. **背壓：** 模組拉高 RTS 時 RP2040 要停送。ring 滿了才丟資料會丟到舊畫面，對即時鏡像不划算；可考慮積壓時整包跳過舊 frame，並照常回報 loss epoch。
4. **腳位：** UART0 用 GP0–GP3，和探針 GP10–GP12 分開，探針仍維持只讀。`SDA／SCL` 被占用，STEMMA QT 不能接其他裝置。

## 實測計畫（P-9）

先用**假資料**量鏈路，不必動現有擷取韌體：RP2040 持續送帶序號和 CRC 的 S3 封包，Mac 統計 kB/s 與錯誤數。每項至少跑 120 秒。

| # | 步驟 | 要回答的問題 |
|---|---|---|
| 1 | 開關切 CMD，9600 8N1 開 RTS/CTS，送 `AT`、`ATI` | 接線對不對？韌體幾版？低於 0.7.0 要先用 app 更新 |
| 2 | `AT+BLEUARTFIFO` 確認 FIFO | 是不是 1024／1024？ |
| 3 | Data 模式、9600，滿載送 | 基準吞吐量與 CRC 錯誤 |
| 4 | 依序 19200、38400、57600、115200，RTS/CTS 全開 | 哪個 baud 開始掉資料？`AT+BAUDRATE` 斷電後保留嗎？ |
| 5 | 用最佳 baud，以幾種固定速率限速送 | 達到多少 kB/s 仍零錯誤？ |
| 6 | 重播 `_output/captures-s3/live-30s-289frames.bin` | 真實負載的延遲與積壓？ |
| 7 | 沒有 central 連線時持續送，再連上 | 資料被丟掉、積壓後送舊資料，還是 RTS 卡住？文件沒寫 |
| 8 | 記錄 `client.mtu_size` 和封包到達間隔 | macOS 實際用的 MTU 與連線間隔？ |

### 依結果決定

| 量到的結果（零錯誤、持續） | 做法 |
|---|---|
| ≥ 2.3 kB/s | 提高 baud 加 RTS/CTS，不做 LZ4 |
| 約 1.5–2.3 kB/s | 同上，尖峰靠 ring 吸收，積壓時跳過舊 frame |
| < 1.5 kB/s 或高 baud 一定掉資料 | 做 P-8 的 LZ4、降低幀率或兩者並用 |
| < 0.9 kB/s | LZ4 估計值 0.86 kB/s 也沒有餘裕，要降幀率或換晶片（如 nRF52 系列） |

Adafruit 的 nRF52 範例標示 [20 ms、MTU 23 時 8.74 KB/s](https://github.com/adafruit/Adafruit_nRF52_Arduino/blob/master/libraries/Bluefruit52Lib/examples/Peripheral/throughput/throughput.ino)，只作為換晶片時的參考。

## 判斷晶片新舊版

看 `ATI` 第 2 行的晶片代號和第 7 行的 SoftDevice。代號對照依 [Nordic nRF51 相容性表 v2.1](https://devzone.nordicsemi.com/cfs-file/__key/communityserver-discussions-components-files/4/nRF51_5F00_Series_5F00_Compatibility_5F00_Matrix_5F00_v2.1.pdf) Table 2。

| `ATI` 第 2 行 | IC revision | RAM |
|---|---|---|
| `QFAC A…` | 3（新） | 32 KB |
| `QFAA H…` | 3（新） | 16 KB |
| `QFAA F…`、`QFAA G…` | 2（舊） | 16 KB |
| `QFAA C…` | 1（舊） | 16 KB |

**[推測]** 產品頁標示 UART Friend 為 32 KB SRAM，而表中 32 KB 的 QF 封裝只有 `QFAC`，所以手上的模組應該是 revision 3。還要看第 7 行是否為 S110 8.0.0：[論壇回覆](https://devzone.nordicsemi.com/f/nordic-q-a/5974/get-uart-error)說 CPU 可用時間的改善要 rev 3 搭配 S110 v8.0.0。

模組外觀是 Raytac MDBT40，nRF51822 在遮罩內看不到代號。[Raytac 型號表](https://raytaccorp.blogspot.com/2026/04/)的後綴 `R` 表示 32 KB RAM（`MDBT40-256RV3` 32 KB、`MDBT40-256V3` 16 KB）；只印 `MDBT40` 分不出來，仍要看 `ATI`。

## 開工前要確認

- `ATI` 回報的韌體與晶片版本。
  手上的板子已由照片確認是 Adafruit 設計：背面有 Adafruit 標誌，印有 `bluefruit Bluetooth LE`、`3-5V Logic UART connect`、`Hardware flow control`、`Vin/VBat: 3-16V`。藍色 PCB 不代表 16 KB：Adafruit 說的藍色 16 KB 是第一代 USB 版 BLE Friend。
- 手機是否能裝 Bluefruit LE Connect（OTA 更新韌體要用）。
- 接收端是否只需要 Mac。其他平台的權限、定址都不同，本文沒涵蓋。
