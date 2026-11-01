// 被動 SPI 擷取（防護評估用）
// --------------------------------------------------------------------------
// 用途：在自有點陣顯示評估板的 控制器→螢幕 SPI 匯流排上「高阻抗被動擷取」，
//       把匯流排位元組原樣倒回主機。還原成畫面文字那一段「不在本程式」
//       （主機端 live_mirror.py / raster.py，見 docs/2nd-screen.md）。
//
// 本程式只做兩件事：
//   1. 用 PIO 以 CS 為 frame 邊界、在 CLK 邊緣取樣 DI，湊成位元組。
//   2. 用 DMA 收進緩衝，每填滿一塊就以十六進位經 USB CDC 倒給主機。
//
// 全部腳位設為「輸入」，PIO 不驅動任何線（被動、不回寫、不接 MISO）。
// --------------------------------------------------------------------------
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/structs/padsbank0.h"
#include "spi_tap.pio.h"

// ── 腳位設定（對應 Feather RP2040 實際接出的腳；依 Adafruit 原理圖校正）─────
// 硬體限制：DI 與 CLK 必須相鄰（CLK = DI + 1），見 .pio 的接線慣例。
// 選 D10/D11/D12（＝GP10/GP11/GP12）：三支相鄰、純數位、無特殊功能、無板上上拉，
// 適合被動高阻抗搭線。注意 Feather 的「Dn」絲印 ≠ GPIO 編號。
//   ✗ 不可用 GP4——Feather 未接出（GP4 = USBBOOT）。
//   ✗ 避開 GP2/GP3——那是 SDA/SCL（I2C/STEMMA），可能帶板上上拉，會載入匯流排。
#define PIN_DI   10  // IN base：資料線     → Feather 腳 D10
#define PIN_CLK  11  // IN base + 1：時脈   → Feather 腳 D11
#define PIN_CS   12  // jmp_pin：晶片選擇   → Feather 腳 D12（低電位有效）

// ⚠ 電平：RP2040 輸入高準位門檻約 2.0V。評估板若為 1.8V 訊號，
//    需加電平轉換/比較器，否則讀不穩（見 docs/2nd-screen.md 前置量測）。

// 每塊擷取的字數（每字低 8 bit = 一個位元組）。2048 B ≈ 一張 128×64 全畫面（約 1024 B
// 像素 + 頁/欄命令）落在單一塊內，倒出延遲約 1～2 次重繪：給 live_mirror.py 做近即時
// 畫面鏡像用。（先前 16384≈16 幀、4096≈4 幀；要「一次 24 字突發落單一無縫塊」再調大。）
// SM 於傾印期間停止，會漏掉當下匯流排；需要完全連續擷取時改雙緩衝 ping-pong DMA（見 README）。
#define CAPTURE_WORDS 2048
static uint32_t capture_buf[CAPTURE_WORDS];

static void dump_hex(const uint32_t *buf, size_t n) {
    // 只輸出匯流排位元組（每字取低 8 bit）。純資料，無任何解讀。
    for (size_t i = 0; i < n; i++) {
        printf("%02x", (unsigned)(buf[i] & 0xff));
        if ((i & 31) == 31) putchar('\n');   // 每 32 bytes 換行，方便主機側解析
    }
    putchar('\n');
}

// 把一支腳鎖成「只能輸入、永不驅動」：關上下拉、OEOVER 強制輸出關閉、pad OD=1。
// OD（Output Disable）硬體上優先於任何周邊的 output-enable，確保不論 SIO/PIO 或
// 暖開機殘留狀態，這條線都不會被 RP2040 拉動——因為它焊在活的評估板匯流排上。
static void lock_input_only(uint pin) {
    gpio_disable_pulls(pin);
    gpio_set_oeover(pin, GPIO_OVERRIDE_LOW);
    hw_set_bits(&padsbank0_hw->io[pin], PADS_BANK0_GPIO0_OD_BITS);
}

int main() {
    // 先把三條探針線鎖成純輸入（在 stdio/USB 等待之前；否則在主機開埠之前，reset
    // 預設的下拉會一直掛在活匯流排上載入訊號）。
    // 不呼叫 pio_gpio_init：PIO 的 IN/WAIT/JMP PIN 永遠讀 pad 輸入同步器，與 FUNCSEL
    // 無關；FUNCSEL=PIO 只是把「輸出」控制權交給 PIO——被動擷取不需要，反而多一條
    // 驅動路徑（暖開機若殘留 PIO pindirs=輸出，切 FUNCSEL 當下就會驅動匯流排）。
    gpio_init(PIN_DI);  gpio_set_dir(PIN_DI,  GPIO_IN); lock_input_only(PIN_DI);
    gpio_init(PIN_CLK); gpio_set_dir(PIN_CLK, GPIO_IN); lock_input_only(PIN_CLK);
    gpio_init(PIN_CS);  gpio_set_dir(PIN_CS,  GPIO_IN); lock_input_only(PIN_CS);

    stdio_init_all();               // USB CDC
    while (!stdio_usb_connected())  // 等主機開啟序列埠再開始
        sleep_ms(100);

    PIO pio = pio0;
    uint sm  = pio_claim_unused_sm(pio, true);
    uint off = pio_add_program(pio, &spi_tap_program);

    // pindirs 設輸入只是向 PIO 明示意圖（FUNCSEL 仍為 SIO，實際由上面的 lock 決定）。
    pio_sm_set_consecutive_pindirs(pio, sm, PIN_DI, 2, false);  // DI, CLK = 輸入
    pio_sm_set_consecutive_pindirs(pio, sm, PIN_CS, 1, false);  // CS     = 輸入

    pio_sm_config c = spi_tap_program_get_default_config(off);
    sm_config_set_in_pins(&c, PIN_DI);       // IN base = DI（CLK = DI+1）
    sm_config_set_jmp_pin(&c, PIN_CS);       // jmp pin = CS
    sm_config_set_in_shift(&c, false, true, 8);  // MSB-first、autopush、門檻 8 bit
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_RX);  // 併 TX FIFO 進 RX，加深緩衝
    pio_sm_init(pio, sm, off, &c);

    // DMA：RX FIFO → capture_buf，受 PIO RX DREQ 節流。
    int dma_ch = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config(dma_ch);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);       // 固定讀 FIFO
    channel_config_set_write_increment(&dc, true);        // 寫入遞增
    channel_config_set_dreq(&dc, pio_get_dreq(pio, sm, false));  // RX DREQ

    printf("# spi_tap ready (DI=GP%d CLK=GP%d CS=GP%d) — bytes only, no decode\n",
           PIN_DI, PIN_CLK, PIN_CS);

    for (;;) {
        dma_channel_configure(dma_ch, &dc,
                              capture_buf,              // 目的
                              &pio->rxf[sm],            // 來源：RX FIFO
                              CAPTURE_WORDS,            // 數量
                              false);
        pio_sm_set_enabled(pio, sm, true);
        dma_channel_start(dma_ch);
        dma_channel_wait_for_finish_blocking(dma_ch);  // 等這塊填滿
        pio_sm_set_enabled(pio, sm, false);

        dump_hex(capture_buf, CAPTURE_WORDS);          // 倒回主機，再抓下一塊
    }
}
