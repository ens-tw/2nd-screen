#ifndef SPI_TAP_STREAM_PROTOCOL_H
#define SPI_TAP_STREAM_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define TAP_HEADER_SIZE 32u
#define TAP_MAX_PAYLOAD 256u
#define TAP_PACKET_SIZE (TAP_HEADER_SIZE + TAP_MAX_PAYLOAD + 4u)
#define TAP_DATA 1u
#define TAP_STATUS 2u
#define TAP_SESSION_START 1u
#define TAP_RLE 2u

static inline void tap_put_u32(uint8_t *out, uint32_t value) {
    for (unsigned i = 0; i < 4; ++i) out[i] = (uint8_t)(value >> (8u * i));
}

static inline uint32_t tap_crc32(const uint8_t *data, size_t length) {
    uint32_t crc = 0xffffffffu;
    for (size_t i = 0; i < length; ++i) {
        crc ^= data[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

// Header: magic, type, flags, uint16 length, then six little-endian uint32s.
// Offset counts captured bytes, including known ring drops. PIO missed bits
// cannot be counted: stall_events reports sticky RXSTALL observations instead.
static inline size_t tap_packet(uint8_t *out, uint8_t type, uint8_t flags,
                                const uint8_t *payload, uint16_t length,
                                uint32_t sequence, uint32_t timestamp_us,
                                uint32_t offset, uint32_t loss_epoch,
                                uint32_t dropped_total, uint32_t stall_events) {
    if (length > TAP_MAX_PAYLOAD) return 0;
    out[0] = 'S'; out[1] = 'T'; out[2] = 'P'; out[3] = '2';
    out[4] = type; out[5] = flags;
    out[6] = (uint8_t)length; out[7] = (uint8_t)(length >> 8);
    const uint32_t fields[] = {sequence, timestamp_us, offset, loss_epoch, dropped_total, stall_events};
    for (unsigned i = 0; i < 6; ++i) tap_put_u32(out + 8u + 4u * i, fields[i]);
    for (unsigned i = 0; i < length; ++i) out[TAP_HEADER_SIZE + i] = payload[i];
    size_t body = TAP_HEADER_SIZE + length;
    tap_put_u32(out + body, tap_crc32(out, body));
    return body + 4u;
}

// Byte-run coding: 0..127 = tag+1 literal bytes; 128..255 = repeat the
// following byte (tag & 127)+3 times. No dictionary or previous-packet state.
// Return 0 if the result does not fit. Input/output must not overlap.
static inline size_t tap_rle_encode(uint8_t *out, size_t capacity,
                                    const uint8_t *data, size_t length) {
    size_t used = 0, i = 0;
    while (i < length) {
        size_t run = 1;
        while (i + run < length && data[i + run] == data[i] && run < 130) run++;
        if (run >= 3) {
            if (capacity - used < 2) return 0;
            out[used++] = (uint8_t)(128 + run - 3);
            out[used++] = data[i];
            i += run;
        } else {
            size_t start = i;
            i += run;
            while (i < length && i - start < 128) {
                if (i + 2 < length && data[i] == data[i + 1] && data[i] == data[i + 2]) break;
                i++;
            }
            size_t count = i - start;
            if (capacity - used < count + 1) return 0;
            out[used++] = (uint8_t)(count - 1);
            for (size_t j = start; j < i; ++j) out[used++] = data[j];
        }
    }
    return used;
}

// Encode directly into the existing packet buffer, with no extra scratch RAM.
// RLE payload = uint16 original length + runs; use raw if that is not smaller.
// Header length counts wire bytes. Offset always counts ORIGINAL bus bytes.
static inline size_t tap_packet_auto(uint8_t *out, uint8_t type, uint8_t flags,
                                     const uint8_t *payload, uint16_t length,
                                     uint32_t sequence, uint32_t timestamp_us,
                                     uint32_t offset, uint32_t epoch,
                                     uint32_t dropped, uint32_t stalls) {
    if (length > TAP_MAX_PAYLOAD) return 0;
    if (type == TAP_DATA && length > 4) {
        uint8_t *encoded = out + TAP_HEADER_SIZE;
        size_t size = tap_rle_encode(encoded + 2, TAP_MAX_PAYLOAD - 2, payload, length);
        if (size && size + 2 < length) {
            encoded[0] = (uint8_t)length;
            encoded[1] = (uint8_t)(length >> 8);
            return tap_packet(out, type, flags | TAP_RLE, encoded, (uint16_t)(size + 2),
                              sequence, timestamp_us, offset, epoch, dropped, stalls);
        }
    }
    return tap_packet(out, type, flags, payload, length,
                      sequence, timestamp_us, offset, epoch, dropped, stalls);
}
#endif
