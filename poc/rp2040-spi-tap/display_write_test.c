// ACTIVE display experiment. Requires isolated/cooperating original controller,
// verified 3.3 V-compatible interface and D/C on GP9. No automatic writes.
// USB HELLO is read-only; a complete CRC-checked WRITE1 request sends one frame.
#include <stdio.h>
#include "pico/stdlib.h"
#include "pico/stdio_usb.h"
#include "hardware/structs/padsbank0.h"
#include "hardware/regs/pads_bank0.h"
#include "display_write_protocol.h"

#define PIN_DI 10u
#define PIN_CLK 11u
#define PIN_CS 12u
#define PIN_DC 9u
#define HALF_PERIOD_US 5u

static const uint pins[] = {PIN_DI, PIN_CLK, PIN_CS, PIN_DC};
static char line[DISPLAY_WRITE_LINE_BYTES + 1];
static uint8_t frame[DISPLAY_FRAME_BYTES];

static void lock_input(uint pin) {
    gpio_set_oeover(pin, GPIO_OVERRIDE_LOW);
    hw_set_bits(&padsbank0_hw->io[pin], PADS_BANK0_GPIO0_OD_BITS);
    gpio_set_dir(pin, GPIO_IN);
    gpio_disable_pulls(pin);
}

static void release_bus(void) {
    // Disable CS output first; every pin returns to high impedance.
    lock_input(PIN_CS);
    lock_input(PIN_CLK);
    lock_input(PIN_DI);
    lock_input(PIN_DC);
}

static void enable_output(uint pin, bool value) {
    // Set latch + direction while both output-disable gates still hold.
    gpio_put(pin, value);
    gpio_set_dir(pin, GPIO_OUT);
    hw_clear_bits(&padsbank0_hw->io[pin], PADS_BANK0_GPIO0_OD_BITS);
    gpio_set_oeover(pin, GPIO_OVERRIDE_NORMAL);
}

static void send_byte(uint8_t byte) {
    for (int bit = 7; bit >= 0; --bit) {
        gpio_put(PIN_DI, (byte >> bit) & 1u);
        busy_wait_us_32(HALF_PERIOD_US);
        gpio_put(PIN_CLK, 1);
        busy_wait_us_32(HALF_PERIOD_US);
        gpio_put(PIN_CLK, 0);
    }
}

static void transaction(bool data, const uint8_t *bytes, size_t length) {
    gpio_put(PIN_DC, data);
    busy_wait_us_32(HALF_PERIOD_US);
    gpio_put(PIN_CS, 0);
    busy_wait_us_32(HALF_PERIOD_US);
    for (size_t i = 0; i < length; ++i) send_byte(bytes[i]);
    busy_wait_us_32(HALF_PERIOD_US);
    gpio_put(PIN_CS, 1);
    busy_wait_us_32(HALF_PERIOD_US);
}

static void write_frame(void) {
    // The hardware must already grant exclusive bus control. Idle sensing
    // cannot establish that, and this firmware does not implement arbitration.
    enable_output(PIN_CS, 1);
    enable_output(PIN_CLK, 0);
    enable_output(PIN_DI, 0);
    enable_output(PIN_DC, 0);
    const uint8_t page_mode[] = {0x20, 0x02};
    transaction(false, page_mode, sizeof(page_mode));
    for (unsigned page = 0; page < 8; ++page) {
        const uint8_t address[] = {(uint8_t)(0xB0 + page), 0x00, 0x10};
        transaction(false, address, sizeof(address));
        transaction(true, frame + page * 128, 128);
    }
    release_bus();
}

int main(void) {
    for (unsigned i = 0; i < sizeof(pins) / sizeof(pins[0]); ++i) {
        gpio_init(pins[i]);
        lock_input(pins[i]);
    }
    stdio_init_all();
    size_t used = 0;
    bool discard = false;
    uint64_t started = 0;
    for (;;) {
        if (!stdio_usb_connected()) {
            used = 0;
            discard = false;
            sleep_ms(5);
            continue;
        }
        int ch = getchar_timeout_us(100000);
        if (ch < 0) {
            if (used && time_us_64() - started > 3000000u) {
                used = 0;
                discard = true;  // Drain truncated command through its newline.
                puts("ERR timeout no-write");
            }
            continue;
        }
        if (ch == '\r') continue;
        if (ch == '\n') {
            line[used] = 0;
            if (discard) {
                puts("ERR malformed no-write");
            } else if (used == 5 && !memcmp(line, "HELLO", 5)) {
                puts(DISPLAY_WRITE_HELLO);
            } else {
                uint32_t crc;
                if (display_parse_write(line, used, frame, &crc)) {
                    write_frame();
                    // ACK means bytes clocked out, not that OLED accepted them.
                    printf("DONE 1024 %08lx HIGH_Z\n", (unsigned long)crc);
                } else {
                    puts("ERR invalid-frame no-write");
                }
            }
            stdio_flush();
            used = 0;
            discard = false;
        } else if (!discard) {
            if (used == 0) started = time_us_64();
            if (ch < 32 || ch > 126 || used >= DISPLAY_WRITE_LINE_BYTES) {
                used = 0;
                discard = true;
            } else {
                line[used++] = (char)ch;
            }
        }
    }
}
