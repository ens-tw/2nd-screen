// 擷取鏈自測：RP2040 on-chip loopback（P-1）
// --------------------------------------------------------------------------
// 目的：在「沒有外接跳線、沒有目標板」的情況下，驗證被動 SPI 擷取的整條
//       擷取鏈是對的——PIO 取樣邏輯（spi_tap.pio）＋ DMA 搬運 ＋ USB CDC 倒出。
//       做法是同一顆晶片「自己驅動、自己擷取同一組腳」：
//
//         本程式用 SIO（一般 GPIO 輸出）在 GP2/GP3/GP4 上打一組「已知」的
//         SPI mode-0 波形（DI/CLK/CS），而 spi_tap.pio 把同一組腳當輸入讀回。
//
//       關鍵事實：RP2040 的 PIO 輸入永遠接在 pad 的輸入同步器上，與 pad 的輸出
//       功能選擇（FUNCSEL）無關。所以 SIO 驅動輸出、PIO 讀輸入，兩者同一組實體
//       腳即可形成晶片內 loopback，毋需任何外部跳線。
//
//       這不是旁觀邏輯，也不含任何畫面內容解讀；只是把 spi_tap 的取樣迴圈餵一組
//       自己產生的已知位元組，確認「抄進來的就是打出去的」。
//
// 已知樣式：第 i 個位元組 = i & 0xFF（0x00,0x01,…,0xFF 循環）。擷取滿一塊後，
//           逐一比對 capture[i] & 0xff == i & 0xff，印出 PASS/FAIL 與不符數。
//
// 腳位與 spi_tap.c 相同（DI=GP2, CLK=GP3, CS=GP4），確保測到的就是正式韌體
// 會用的同一條取樣路徑。CS 低電位有效，整塊擷取期間維持低電位（單一長 frame），
// 起始對齊靠「SM 先在 CS 高時 park 於 idle，再拉低 CS」取得，故 capture[0] 對齊
// 產生端的 byte0，比對無相位偏移。
// --------------------------------------------------------------------------
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "spi_tap.pio.h"

// 與 spi_tap.c 一致的腳位：D10/D11/D12 = GP10/GP11/GP12（Feather 實際接出腳）。
// loopback 為晶片內自測，腳是否接出 header 不影響；對齊只為與正式韌體一致。
#define PIN_DI   10  // IN base：資料線
#define PIN_CLK  11  // IN base + 1：時脈
#define PIN_CS   12  // jmp_pin：晶片選擇（低電位有效）

// 一塊擷取的字數（每字低 8 bit = 一個位元組），與 spi_tap.c 相同，連帶驗證
// 同樣大小的 DMA 搬運與緩衝都正確。
#define CAPTURE_WORDS 16384
static uint32_t capture_buf[CAPTURE_WORDS];

// 產生端半位元延遲（微秒）：PIO 以邊緣觸發取樣，速率不敏感；給足夠餘裕讓
// DI 在 CLK 上升前穩定、並維持到取樣之後，邊緣乾淨即可。
#define HALF_US 2

// 用 SIO 打出一個位元組，MSB 先出，SPI mode 0（DI 在 CLK 低時變、CLK 上升緣被取樣）。
static inline void gen_byte(uint8_t b) {
    for (int bit = 7; bit >= 0; bit--) {
        gpio_put(PIN_DI, (b >> bit) & 1);  // 先擺好資料
        sleep_us(HALF_US);
        gpio_put(PIN_CLK, 1);              // 上升緣 → tap 取樣
        sleep_us(HALF_US);
        gpio_put(PIN_CLK, 0);              // 回落
        sleep_us(HALF_US);
    }
}

int main() {
    stdio_init_all();               // USB CDC
    while (!stdio_usb_connected())  // 等主機開啟序列埠再開始
        sleep_ms(100);

    // ── 產生端：三條線設為 SIO 輸出（不呼叫 pio_gpio_init，讓 SIO 保有輸出權；
    //    PIO 仍能從 pad 讀輸入）。CS 先拉高（idle），讓 tap 先 park 住。
    gpio_init(PIN_DI);  gpio_set_dir(PIN_DI,  GPIO_OUT); gpio_put(PIN_DI, 0);
    gpio_init(PIN_CLK); gpio_set_dir(PIN_CLK, GPIO_OUT); gpio_put(PIN_CLK, 0);
    gpio_init(PIN_CS);  gpio_set_dir(PIN_CS,  GPIO_OUT); gpio_put(PIN_CS, 1);

    // ── 擷取端：載入與正式韌體相同的 spi_tap PIO 程式。
    PIO pio = pio0;
    uint sm  = pio_claim_unused_sm(pio, true);
    uint off = pio_add_program(pio, &spi_tap_program);

    pio_sm_config c = spi_tap_program_get_default_config(off);
    sm_config_set_in_pins(&c, PIN_DI);              // IN base = DI（CLK = DI+1）
    sm_config_set_jmp_pin(&c, PIN_CS);              // jmp pin = CS
    sm_config_set_in_shift(&c, false, true, 8);     // MSB-first、autopush、門檻 8 bit
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_RX);  // 併 TX FIFO 進 RX
    pio_sm_init(pio, sm, off, &c);
    // 注意：此處「不」設定這些腳的 PIO pindirs、也不 pio_gpio_init——輸出權歸 SIO，
    //       PIO 只讀輸入。這正是 loopback 的關鍵。

    // ── DMA：RX FIFO → capture_buf，受 PIO RX DREQ 節流（與 spi_tap.c 相同）。
    int dma_ch = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config(dma_ch);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_32);
    channel_config_set_read_increment(&dc, false);
    channel_config_set_write_increment(&dc, true);
    channel_config_set_dreq(&dc, pio_get_dreq(pio, sm, false));

    printf("# loopback_test ready (DI=GP%d CLK=GP%d CS=GP%d) — on-chip self-test, no jumper\n",
           PIN_DI, PIN_CLK, PIN_CS);

    unsigned round = 0;
    for (;;) {
        // 重置 SM 到程式起點（idle），清 FIFO 與移位暫存器，確保每塊重新對齊。
        pio_sm_set_enabled(pio, sm, false);
        pio_sm_clear_fifos(pio, sm);
        pio_sm_restart(pio, sm);
        pio_sm_exec(pio, sm, pio_encode_jmp(off));  // PC → idle

        dma_channel_configure(dma_ch, &dc,
                              capture_buf, &pio->rxf[sm], CAPTURE_WORDS, false);

        gpio_put(PIN_CS, 1);            // 確保 idle 高電位
        pio_sm_set_enabled(pio, sm, true);  // SM park 在 idle（CS 高）
        dma_channel_start(dma_ch);

        // 開始一個長 frame：拉低 CS，讓 tap 落入 bitloop 等第一個上升緣，
        // 之後連續打出已知位元組（DMA 在背景搬運，CPU 同時產生波形）。
        sleep_us(5);                   // 給 SM 一點時間從 idle 落到 wait
        gpio_put(PIN_CS, 0);
        sleep_us(5);
        for (uint32_t i = 0; i < CAPTURE_WORDS; i++)
            gen_byte((uint8_t)(i & 0xff));
        gpio_put(PIN_CS, 1);           // frame 結束

        dma_channel_wait_for_finish_blocking(dma_ch);
        pio_sm_set_enabled(pio, sm, false);

        // ── 比對：capture[i] & 0xff 應等於 i & 0xff。
        uint32_t mismatches = 0;
        int first_bad = -1;
        for (uint32_t i = 0; i < CAPTURE_WORDS; i++) {
            uint8_t got = (uint8_t)(capture_buf[i] & 0xff);
            uint8_t exp = (uint8_t)(i & 0xff);
            if (got != exp) {
                mismatches++;
                if (first_bad < 0) first_bad = (int)i;
            }
        }

        printf("round %u: %s  (%u/%u bytes mismatch)\n",
               round, mismatches == 0 ? "PASS" : "FAIL",
               (unsigned)mismatches, (unsigned)CAPTURE_WORDS);
        if (mismatches) {
            uint8_t g = (uint8_t)(capture_buf[first_bad] & 0xff);
            printf("  first mismatch @%d: got %02x exp %02x\n",
                   first_bad, g, (unsigned)(first_bad & 0xff));
        }
        // 前 32 個擷取位元組，供主機端眼睛核對（應為 00 01 02 … 1f）。
        printf("  head:");
        for (int i = 0; i < 32; i++) printf(" %02x", (unsigned)(capture_buf[i] & 0xff));
        putchar('\n');

        round++;
        sleep_ms(1000);
    }
}
