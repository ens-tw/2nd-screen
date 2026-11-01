#ifndef SPI_TAP_STREAM_PROTOCOL_H
#define SPI_TAP_STREAM_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define TAP_STATUS_HEADER_SIZE 32u
#define TAP_STATUS_PACKET_SIZE (TAP_STATUS_HEADER_SIZE + 4u)
#define TAP_STATUS 2u
#define TAP_SESSION_START 1u
#define TAP_RLE 2u
#define TAP_COMPACT_HEADER_SIZE 8u
#define TAP_COMPACT_MAX_PAYLOAD 2048u
#define TAP_COMPACT_PACKET_SIZE (TAP_COMPACT_HEADER_SIZE + TAP_COMPACT_MAX_PAYLOAD + 4u)

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

// Status: "STP2", type, flags, uint16 zero length, six little-endian uint32s, CRC32.
// Offset counts captured bytes, including known ring drops. PIO missed bits
// cannot be counted: stall_events reports sticky RXSTALL observations instead.
static inline size_t tap_status_packet(uint8_t *out, uint8_t flags,
                                       uint32_t sequence, uint32_t timestamp_us,
                                       uint32_t offset, uint32_t loss_epoch,
                                       uint32_t dropped_total, uint32_t stall_events) {
    out[0] = 'S'; out[1] = 'T'; out[2] = 'P'; out[3] = '2';
    out[4] = TAP_STATUS; out[5] = flags;
    out[6] = 0; out[7] = 0;
    const uint32_t fields[] = {sequence, timestamp_us, offset, loss_epoch, dropped_total, stall_events};
    for (unsigned i = 0; i < 6; ++i) tap_put_u32(out + 8u + 4u * i, fields[i]);
    tap_put_u32(out + TAP_STATUS_HEADER_SIZE, tap_crc32(out, TAP_STATUS_HEADER_SIZE));
    return TAP_STATUS_PACKET_SIZE;
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

// Compact data packet: "S3", flags, sequence low 8 bits, uint16 wire length,
// offset low 16 bits, payload, CRC32. Epoch and counters are not repeated: any
// change to them is announced by a status packet before the next data.
// RLE payload = uint16 original length + runs; raw if that is not smaller.
// Wire length counts wire bytes. Offset always counts ORIGINAL bus bytes.
// Each packet decodes on its own.
static inline size_t tap_compact_packet(uint8_t *out, const uint8_t *payload, uint16_t length,
                                        uint32_t sequence, uint32_t offset) {
    if (!length || length > TAP_COMPACT_MAX_PAYLOAD) return 0;
    uint8_t flags = 0;
    uint8_t *wire = out + TAP_COMPACT_HEADER_SIZE;
    uint16_t wire_length = length;
    size_t size = length > 4
        ? tap_rle_encode(wire + 2, TAP_COMPACT_MAX_PAYLOAD - 2, payload, length) : 0;
    if (size && size + 2 < length) {
        flags = TAP_RLE;
        wire[0] = (uint8_t)length;
        wire[1] = (uint8_t)(length >> 8);
        wire_length = (uint16_t)(size + 2);
    } else {
        for (unsigned i = 0; i < length; ++i) wire[i] = payload[i];
    }
    out[0] = 'S'; out[1] = '3';
    out[2] = flags;
    out[3] = (uint8_t)sequence;
    out[4] = (uint8_t)wire_length; out[5] = (uint8_t)(wire_length >> 8);
    out[6] = (uint8_t)offset; out[7] = (uint8_t)(offset >> 8);
    size_t body = TAP_COMPACT_HEADER_SIZE + wire_length;
    tap_put_u32(out + body, tap_crc32(out, body));
    return body + 4u;
}
#endif
