// Passive SPI -> continuous DMA ring -> nonblocking binary USB CDC stream.
// Probe pins remain input-only, with OEOVER + pad OD locked before USB init.
#include <string.h>
#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "hardware/sync.h"
#include "hardware/structs/padsbank0.h"
#include "tusb.h"
#include "spi_tap.pio.h"
#include "stream_protocol.h"

#define PIN_DI 10
#define PIN_CLK 11
#define PIN_CS 12
#define RING_BITS 15u
#define RING_SIZE (1u << RING_BITS)
#define RING_MASK (RING_SIZE - 1u)
#define FLUSH_US 1000u
#define HEARTBEAT_US 250000u

static uint8_t ring[RING_SIZE] __attribute__((aligned(RING_SIZE)));
static const uint32_t reload_count = RING_SIZE;
static volatile uint32_t completed_rings;
static int data_dma, reload_dma;

// The reload channel restarts data DMA in hardware. IRQ only counts full rings;
// it does not rearm capture, so USB servicing cannot introduce a rearm gap.
static void dma_complete(void) {
    uint32_t bit = 1u << data_dma;
    if (dma_hw->ints0 & bit) {
        completed_rings++;
        dma_hw->ints0 = bit;
    }
}

static uint32_t producer_position(uint32_t previous) {
    for (;;) {
        uint32_t irq_state = save_and_disable_interrupts();
        uint32_t cycles = completed_rings;
        uint32_t before = dma_hw->ints0 & (1u << data_dma);
        uint32_t index = (dma_hw->ch[data_dma].write_addr - (uintptr_t)ring) & RING_MASK;
        uint32_t after = dma_hw->ints0 & (1u << data_dma);
        restore_interrupts(irq_state);
        if (before != after) continue;
        uint32_t head = (cycles + (after != 0)) * RING_SIZE + index;
        // The write address can wrap just before the completion IRQ is raised.
        // Retry that tiny window instead of reporting a backwards producer.
        if ((uint32_t)(head - previous) < 0x80000000u) {
            __dmb();
            return head;
        }
    }
}

// 把一支腳鎖成「只能輸入、永不驅動」：關上下拉、OEOVER 強制輸出關閉、pad OD=1。
// OD（Output Disable）硬體上優先於任何周邊的 output-enable，確保不論 SIO/PIO 或
// 暖開機殘留狀態，這條線都不會被 RP2040 拉動——因為它焊在活的評估板匯流排上。
static void lock_input_only(uint pin) {
    gpio_disable_pulls(pin);
    gpio_set_oeover(pin, GPIO_OVERRIDE_LOW);
    hw_set_bits(&padsbank0_hw->io[pin], PADS_BANK0_GPIO0_OD_BITS);
}


int main(void) {
    gpio_init(PIN_DI);  gpio_set_dir(PIN_DI, GPIO_IN); lock_input_only(PIN_DI);
    gpio_init(PIN_CLK); gpio_set_dir(PIN_CLK, GPIO_IN); lock_input_only(PIN_CLK);
    gpio_init(PIN_CS);  gpio_set_dir(PIN_CS, GPIO_IN); lock_input_only(PIN_CS);

    PIO pio = pio0;
    uint sm = pio_claim_unused_sm(pio, true);
    uint program = pio_add_program(pio, &spi_tap_program);
    pio_sm_set_consecutive_pindirs(pio, sm, PIN_DI, 2, false);
    pio_sm_set_consecutive_pindirs(pio, sm, PIN_CS, 1, false);
    pio_sm_config pc = spi_tap_program_get_default_config(program);
    sm_config_set_in_pins(&pc, PIN_DI);
    sm_config_set_jmp_pin(&pc, PIN_CS);
    sm_config_set_in_shift(&pc, false, true, 8);
    sm_config_set_fifo_join(&pc, PIO_FIFO_JOIN_RX);
    pio_sm_init(pio, sm, program, &pc);

    data_dma = dma_claim_unused_channel(true);
    reload_dma = dma_claim_unused_channel(true);
    dma_channel_config dc = dma_channel_get_default_config(data_dma);
    channel_config_set_transfer_data_size(&dc, DMA_SIZE_8);
    channel_config_set_read_increment(&dc, false);
    channel_config_set_write_increment(&dc, true);
    channel_config_set_ring(&dc, true, RING_BITS);
    channel_config_set_dreq(&dc, pio_get_dreq(pio, sm, false));
    channel_config_set_chain_to(&dc, reload_dma);
    channel_config_set_high_priority(&dc, true);
    dma_channel_configure(data_dma, &dc, ring, &pio->rxf[sm], RING_SIZE, false);

    dma_channel_config rc = dma_channel_get_default_config(reload_dma);
    channel_config_set_transfer_data_size(&rc, DMA_SIZE_32);
    channel_config_set_read_increment(&rc, false);
    channel_config_set_write_increment(&rc, false);
    dma_channel_configure(reload_dma, &rc,
                          &dma_hw->ch[data_dma].al1_transfer_count_trig,
                          &reload_count, 1, false);
    dma_hw->ints0 = 1u << data_dma;
    dma_channel_set_irq0_enabled(data_dma, true);
    irq_set_exclusive_handler(DMA_IRQ_0, dma_complete);
    irq_set_enabled(DMA_IRQ_0, true);
    pio->fdebug = 1u << (PIO_FDEBUG_RXSTALL_LSB + sm);
    dma_channel_start(data_dma);
    pio_sm_set_enabled(pio, sm, true);
    tusb_init();

    uint32_t head = 0, tail = 0, dropped = 0, stalls = 0, epoch = 0, sequence = 0;
    uint32_t last_send = time_us_32();
    bool was_connected = false, session_start = true;
    uint8_t packet[TAP_PACKET_SIZE], payload[TAP_MAX_PAYLOAD];
    size_t tx_length = 0, tx_sent = 0;

    for (;;) {
        tud_task();
        head = producer_position(head);
        uint32_t stall_bit = 1u << (PIO_FDEBUG_RXSTALL_LSB + sm);
        if (pio->fdebug & stall_bit) {
            pio->fdebug = stall_bit;
            stalls++;
            epoch++;
            // Conservatively discard backlog around a detected sampling fault.
            dropped += head - tail;
            tail = head;
        }
        bool connected = tud_cdc_connected();
        if (!connected) {
            dropped += head - tail;
            tail = head;
            if (was_connected) epoch++;
            was_connected = false;
            tx_length = tx_sent = 0;
            continue;
        }
        if (!was_connected) {
            // A new reader starts with a status record and explicit continuity reset.
            epoch++;
            session_start = true;
            was_connected = true;
            last_send = time_us_32() - HEARTBEAT_US;
        }
        uint32_t available = head - tail;
        if (available > RING_SIZE - TAP_MAX_PAYLOAD) {
            dropped += available;
            tail = head;
            epoch++;
            available = 0;
        }

        if (tx_sent < tx_length) {
            uint32_t capacity = tud_cdc_write_available();
            uint32_t remaining = (uint32_t)(tx_length - tx_sent);
            if (capacity > remaining) capacity = remaining;
            if (capacity) tx_sent += tud_cdc_write(packet + tx_sent, capacity);
            tud_cdc_write_flush();
            continue;
        }
        uint32_t now = time_us_32();
        if (session_start || available >= TAP_MAX_PAYLOAD ||
            (available && (uint32_t)(now - last_send) >= FLUSH_US) ||
            (uint32_t)(now - last_send) >= HEARTBEAT_US) {
            uint16_t count = session_start ? 0 : (available > TAP_MAX_PAYLOAD ? TAP_MAX_PAYLOAD : available);
            uint32_t offset = tail;
            for (unsigned i = 0; i < count; ++i) payload[i] = ring[(tail + i) & RING_MASK];
            // DMA keeps running during the copy. Reject a copy overtaken by DMA.
            head = producer_position(head);
            if (head - tail > RING_SIZE - TAP_MAX_PAYLOAD) continue;
            tx_length = tap_packet(packet, count ? TAP_DATA : TAP_STATUS,
                                   session_start ? TAP_SESSION_START : 0,
                                   payload, count, sequence++, now, offset, epoch, dropped, stalls);
            tx_sent = 0;
            tail += count;
            session_start = false;
            last_send = now;
        }
    }
}
