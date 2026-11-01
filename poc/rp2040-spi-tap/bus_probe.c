// 匯流排探針（被動診斷，無示波器時用）
// --------------------------------------------------------------------------
// 目的：在沒有示波器的情況下，用 RP2040 自己回答「搭上去的這條匯流排，
//       我讀不讀得到、它有沒有在翻動、大概多快」——用的是 RP2040 真正的輸入
//       門檻，所以結論直接等於「正式 tap 讀不讀得到」。
//
// 本韌體「純被動」：三支探針腳全輸入、關下拉、並以硬體 OEOVER/OD 鎖成永不驅動，
//       可安全在已焊上評估板活匯流排時執行（與 loopback_test 相反——那支會把
//       腳設成輸出打波形，**絕不可**在接著評估板時燒）。
//
// 做三件事：
//   1. LED 心跳：板載 LED（GP13）持續閃，USB 沒接也看得到「程式在跑」。
//   2. CLK 邊緣計數：PWM slice 5B（GP11=CLK）硬體計上升緣，wrap 中斷累計成單調
//      計數；每窗取差分算速率（連續不歸零→短突發不會掉在視窗間）。
//   3. 取樣準位：印出 RP2040 在 DI/CLK/CS 上當下讀到的邏輯值（0/1）。
//
// 判讀（都不靠波形）：
//   - 切換評估板畫面時 CLK rising/s **跳起來** → RP2040 偵測得到邊緣
//     （準位至少跨過門檻）；若靜態時歸零＝依變動突發（write-on-change）。
//   - 畫面確實在更新、rising/s **一直 0** → 偵測不到可辨識邊緣：可能準位太低
//     （1.8V < V_IH，要電平轉換），或腳位/接觸問題。
//   - 靜態畫面 rising/s 也**持續很高** → 連續刷新 → 要改資料率模型。
//   注意：有計數不保證準位「充裕」（邊緣的可能只是剛好跨過門檻）；此數為視窗
//        平均邊緣率，不是 burst 內的 SCK 頻率。
//
// --------------------------------------------------------------------------
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pwm.h"
#include "hardware/irq.h"
#include "hardware/sync.h"
#include "hardware/structs/padsbank0.h"

// 腳位與 spi_tap.c 一致：D10/D11/D12 = GP10/GP11/GP12（Feather 實際接出腳）。
#define PIN_DI   10  // 資料線
#define PIN_CLK  11  // 時脈（= PWM slice 5, 通道 B，可硬體計邊緣）
#define PIN_CS   12  // 晶片選擇

#ifndef PICO_DEFAULT_LED_PIN
#define PICO_DEFAULT_LED_PIN 13  // Feather RP2040 板載紅 LED
#endif
#define PIN_LED  PICO_DEFAULT_LED_PIN

#define CLK_SLICE 5  // pwm_gpio_to_slice_num(11) = 5；通道 B = GP11（硬體固定）

static volatile uint32_t g_wraps = 0;  // PWM 計數器溢位次數（每次 +65536 個邊緣）

static void on_pwm_wrap(void) {
    pwm_clear_irq(CLK_SLICE);
    g_wraps++;
}

// 把一支腳鎖成「只能輸入、永不驅動」：關上下拉、OEOVER 強制輸出關閉、pad OD=1。
// OD（Output Disable）在硬體上優先於任何周邊的 output-enable，確保不論 SIO/PIO/PWM
// 或初始化空檔，這條線都不會被 RP2040 拉動——因為它焊在活的評估板匯流排上。
static void lock_input_only(uint pin) {
    gpio_disable_pulls(pin);
    gpio_set_oeover(pin, GPIO_OVERRIDE_LOW);
    hw_set_bits(&padsbank0_hw->io[pin], PADS_BANK0_GPIO0_OD_BITS);
}

// 在關中斷下安全讀「單調總邊緣數」：若讀到時剛好有未服務的 wrap（計數器已翻、
// ISR 還沒跑），計數器會讀到翻過後的小值而 g_wraps 仍是舊值 → 以 INTS pending
// 旗標補一個 wrap 並重讀計數器。視窗夠短，最多一個 pending。
static uint32_t read_total_edges(void) {
    uint32_t save = save_and_disable_interrupts();
    uint32_t c = pwm_get_counter(CLK_SLICE);
    uint32_t w = g_wraps;
    if (pwm_get_irq_status_mask() & (1u << CLK_SLICE)) {
        c = pwm_get_counter(CLK_SLICE);  // 保證是翻過後的值
        w++;                             // 與重讀到的小 c 相配
    }
    restore_interrupts(save);
    return (w << 16) + c;
}

int main(void) {
    // ── 1) 先把三支探針腳鎖成純輸入（在 stdio/任何其他動作之前，杜絕驅動活匯流排）──
    const uint pins[3] = {PIN_DI, PIN_CLK, PIN_CS};
    for (int i = 0; i < 3; i++) {
        gpio_init(pins[i]);
        gpio_set_dir(pins[i], GPIO_IN);
        lock_input_only(pins[i]);
    }

    // ── 2) PWM 先設成 B 上升緣計數模式（此時通道 B 為輸入、pwm_oe_b=0，不驅動），
    //       設定好後才把 GP11 的腳位功能切到 PWM，避免在 free-running 預設下驅動 CLK。──
    pwm_config cfg = pwm_get_default_config();
    pwm_config_set_clkdiv_mode(&cfg, PWM_DIV_B_RISING);  // 計 B 腳外部上升緣（divider 預設 1）
    pwm_config_set_wrap(&cfg, 0xFFFF);                   // 滿 65535 翻一次 → wrap 中斷 +1
    pwm_init(CLK_SLICE, &cfg, false);

    gpio_set_function(PIN_CLK, GPIO_FUNC_PWM);
    lock_input_only(PIN_CLK);  // gpio_set_function 會清掉 OEOVER/OD，重設一次保持被動

    pwm_clear_irq(CLK_SLICE);
    pwm_set_irq_enabled(CLK_SLICE, true);
    irq_set_exclusive_handler(PWM_IRQ_WRAP, on_pwm_wrap);
    irq_set_enabled(PWM_IRQ_WRAP, true);
    pwm_set_enabled(CLK_SLICE, true);

    // ── 3) LED（GP13，輸出，我們要驅動的唯一一支腳）──
    gpio_init(PIN_LED);
    gpio_set_dir(PIN_LED, GPIO_OUT);

    // ── 4) stdio 最後起；不等 stdio_usb_connected()，LED 要能先閃 ──
    stdio_init_all();

    printf("# bus_probe ready (DI=GP%d CLK=GP%d CS=GP%d, LED=GP%d) — passive, output-locked\n",
           PIN_DI, PIN_CLK, PIN_CS, PIN_LED);

    uint32_t prev = read_total_edges();
    for (;;) {
        // 約 1 秒，期間 LED 以 ~5Hz 閃（硬體在背景連續計 CLK 邊緣，不受影響、不歸零）
        for (int i = 0; i < 10; i++) {
            gpio_put(PIN_LED, i & 1);
            sleep_ms(100);
        }

        uint32_t now = read_total_edges();
        uint32_t edges = now - prev;  // 無號 2^32 模差分；單調計數→視窗間無盲區
        prev = now;

        int di = gpio_get(PIN_DI), clk = gpio_get(PIN_CLK), cs = gpio_get(PIN_CS);
        printf("# alive  CLK rising/s=%lu (total=%lu)  sample DI=%d CLK=%d CS=%d\n",
               (unsigned long)edges, (unsigned long)now, di, clk, cs);
    }
}
