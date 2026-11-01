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
#endif
