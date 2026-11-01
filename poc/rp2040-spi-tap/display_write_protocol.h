#ifndef DISPLAY_WRITE_PROTOCOL_H
#define DISPLAY_WRITE_PROTOCOL_H

#include <stdbool.h>
#include <string.h>
#include "stream_protocol.h"

#define DISPLAY_FRAME_BYTES 1024u
// WRITE1 + space + 8 CRC hex digits + space + 2048 frame hex digits.
#define DISPLAY_WRITE_LINE_BYTES (16u + 2u * DISPLAY_FRAME_BYTES)
#define DISPLAY_WRITE_HELLO "DISPLAY_WRITE_TEST 1 DI=10 CLK=11 CS=12 DC=9"

static inline int display_hex_digit(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

// No GPIO operations. Validate the entire request before the caller can drive.
static inline bool display_parse_write(const char *line, size_t length,
                                        uint8_t *frame, uint32_t *crc_out) {
    if (length != DISPLAY_WRITE_LINE_BYTES || memcmp(line, "WRITE1 ", 7) || line[15] != ' ')
        return false;
    uint32_t crc = 0;
    for (unsigned i = 7; i < 15; ++i) {
        int digit = display_hex_digit(line[i]);
        if (digit < 0) return false;
        crc = (crc << 4) | (uint32_t)digit;
    }
    for (unsigned i = 0; i < DISPLAY_FRAME_BYTES; ++i) {
        int hi = display_hex_digit(line[16 + 2 * i]);
        int lo = display_hex_digit(line[17 + 2 * i]);
        if (hi < 0 || lo < 0) return false;
        frame[i] = (uint8_t)((hi << 4) | lo);
    }
    if (tap_crc32(frame, DISPLAY_FRAME_BYTES) != crc) return false;
    *crc_out = crc;
    return true;
}

#endif
