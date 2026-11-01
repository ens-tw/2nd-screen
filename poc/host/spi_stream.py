"""Binary transport: CRC-checked packets and explicit continuity tracking.

Data travels in compact packets, normally one per bus burst. Full device state
travels in status packets. USB packet/read boundaries have no display meaning.
Only a device loss epoch, sequence/offset discontinuity, restart, or transport
corruption breaks assembly.
"""
import struct
import zlib

STATUS_MAGIC = b'STP2'
STATUS_HEADER = struct.Struct('<4sBBHIIIIII')
COMPACT_MAGIC = b'S3'
# Magic, flags, sequence low 8 bits, wire length, offset low 16 bits.
COMPACT_HEADER = struct.Struct('<2sBBHH')
COMPACT_OVERHEAD = COMPACT_HEADER.size + 4
COMPACT_MAX_PAYLOAD = 2048
DATA, STATUS, SESSION_START = 1, 2, 1
RLE = 2
MASK32 = 0xffffffff


def rle_encode(data):
    """Reference encoder for offline measurements and firmware interoperability."""
    out = bytearray()
    i = 0
    while i < len(data):
        run = 1
        while i + run < len(data) and data[i + run] == data[i] and run < 130:
            run += 1
        if run >= 3:
            out.extend((128 + run - 3, data[i]))
            i += run
        else:
            start = i
            i += run
            while i < len(data) and i - start < 128:
                if i + 2 < len(data) and data[i] == data[i + 1] == data[i + 2]:
                    break
                i += 1
            out.append(i - start - 1)
            out.extend(data[start:i])
    return bytes(out)


def compact_packet(payload, sequence, offset):
    """Reference encoder for tap_compact_packet: RLE when smaller, otherwise raw."""
    encoded = struct.pack('<H', len(payload)) + rle_encode(payload)
    use_rle = len(payload) > 4 and len(encoded) < len(payload)
    wire = encoded if use_rle else payload
    body = COMPACT_HEADER.pack(COMPACT_MAGIC, RLE if use_rle else 0, sequence & 0xff,
                               len(wire), offset & 0xffff) + wire
    return body + struct.pack('<I', zlib.crc32(body))


def rle_decode(payload):
    """Decode one RLE payload, bounded by the packet format's original-length limit."""
    if len(payload) < 4:
        raise ValueError('RLE payload too short')
    expected = int.from_bytes(payload[:2], 'little')
    if not 1 <= expected <= COMPACT_MAX_PAYLOAD:
        raise ValueError('Invalid RLE original length')
    out = bytearray()
    i = 2
    while i < len(payload):
        tag = payload[i]
        i += 1
        count = tag + 1 if tag < 128 else (tag & 127) + 3
        if len(out) + count > expected:
            raise ValueError('RLE output exceeds original length')
        if tag < 128:
            if i + count > len(payload):
                raise ValueError('Truncated RLE literal')
            out.extend(payload[i:i + count])
            i += count
        else:
            if i >= len(payload):
                raise ValueError('Truncated RLE repeat')
            out.extend(bytes([payload[i]]) * count)
            i += 1
    if len(out) != expected:
        raise ValueError('RLE length mismatch')
    return bytes(out)


class CompressionStats:
    """Savings across valid data packets, including header and CRC overhead.

    Min/max are per packet; average is weighted by original packet byte count.
    Ignore status heartbeats so idle time does not dilute the compression ratio.
    """
    def __init__(self):
        self.packets = 0
        self.original_bytes = 0
        self.wire_bytes = 0
        self.minimum = None
        self.maximum = None

    def observe(self, original_length, wire_length):
        original = COMPACT_OVERHEAD + original_length
        wire = COMPACT_OVERHEAD + wire_length
        savings = 100 * (1 - wire / original)
        self.packets += 1
        self.original_bytes += original
        self.wire_bytes += wire
        self.minimum = savings if self.minimum is None else min(self.minimum, savings)
        self.maximum = savings if self.maximum is None else max(self.maximum, savings)

    def summary(self):
        return dict(data_packets=self.packets, original_packet_bytes=self.original_bytes,
                    wire_packet_bytes=self.wire_bytes,
                    min_saved_percent=self.minimum, max_saved_percent=self.maximum,
                    avg_saved_percent=(100 * (1 - self.wire_bytes / self.original_bytes)
                                       if self.packets else None))


class StreamParser:
    def __init__(self, on_data, on_gap, diagnostics=None):
        self.on_data = on_data
        self.on_gap = on_gap
        self.diagnostics = diagnostics
        self.pending = bytearray()
        self.previous = None
        self.expected_offset = None
        self.resync = False
        self.compression = CompressionStats()

    def event(self, kind, **details):
        if self.diagnostics is not None:
            self.diagnostics(kind, **details)

    def next_magic(self):
        starts = (self.pending.find(STATUS_MAGIC), self.pending.find(COMPACT_MAGIC))
        return min((start for start in starts if start >= 0), default=-1)

    def widen_compact(self, sequence, offset):
        """Rebuild full counters from their low bits and the last packet's state."""
        if self.previous is None:
            return sequence, offset, 0, 0, 0
        last = self.previous
        expected = (last['sequence'] + 1) & MASK32
        sequence = (expected + ((sequence - expected) & 0xff)) & MASK32
        offset = (self.expected_offset + ((offset - self.expected_offset) & 0xffff)) & MASK32
        return sequence, offset, last['loss_epoch'], last['dropped_total'], last['stall_events']

    def feed(self, chunk):
        self.pending.extend(chunk)
        while True:
            start = self.next_magic()
            if start < 0:
                count = max(0, len(self.pending) - len(STATUS_MAGIC) + 1)
                if count:
                    self.event('transport_noise', hex=self.pending[:count].hex())
                    del self.pending[:count]
                    self.resync = True
                return
            if start:
                self.event('transport_noise', hex=self.pending[:start].hex())
                del self.pending[:start]
                self.resync = True
            compact = self.pending.startswith(COMPACT_MAGIC)
            header_size = COMPACT_HEADER.size if compact else STATUS_HEADER.size
            if len(self.pending) < header_size:
                return
            if compact:
                _, flags, seq, length, offset = COMPACT_HEADER.unpack_from(self.pending)
                kind, stamp = DATA, None
                invalid = flags & ~RLE or not 1 <= length <= COMPACT_MAX_PAYLOAD
            else:
                magic, kind, flags, length, seq, stamp, offset, epoch, dropped, stalls = \
                    STATUS_HEADER.unpack_from(self.pending)
                invalid = kind != STATUS or flags & ~SESSION_START or length
            if invalid:
                self.event('transport_bad_header', hex=self.pending[:header_size].hex())
                del self.pending[:1]
                self.resync = True
                continue
            total = header_size + length + 4
            if len(self.pending) < total:
                return
            body = self.pending[:header_size + length]
            crc = struct.unpack_from('<I', self.pending, header_size + length)[0]
            if zlib.crc32(body) != crc:
                self.event('transport_bad_crc', sequence=seq, hex=self.pending[:total].hex())
                del self.pending[:1]
                self.resync = True
                continue
            payload = bytes(self.pending[header_size:header_size + length])
            del self.pending[:total]
            if compact:
                seq, offset, epoch, dropped, stalls = self.widen_compact(seq, offset)
            if flags & RLE:
                try:
                    payload = rle_decode(payload)
                except ValueError as error:
                    self.event('transport_bad_compression', sequence=seq, reason=str(error))
                    self.resync = True
                    continue
            fields = dict(packet_type=kind, flags=flags, sequence=seq, device_us=stamp,
                          device_offset=offset, loss_epoch=epoch,
                          dropped_total=dropped, stall_events=stalls)
            reasons = []
            if self.resync:
                reasons.append('transport-resync')
            if not compact and flags & SESSION_START:
                reasons.append('session-start')
            if self.previous is not None:
                if seq != (self.previous['sequence'] + 1) & MASK32:
                    reasons.append('packet-sequence')
                if offset != self.expected_offset:
                    reasons.append('byte-offset')
                if epoch != self.previous['loss_epoch']:
                    reasons.append('loss-epoch')
                if dropped != self.previous['dropped_total']:
                    reasons.append('ring-drop')
                if stalls != self.previous['stall_events']:
                    reasons.append('pio-stall')
            if reasons:
                reason = ','.join(reasons)
                self.event('stream_gap', reason=reason, **fields)
                self.on_gap(reason)
            if kind == DATA:
                self.compression.observe(len(payload), length)
            self.event('stream_packet', payload_length=len(payload), wire_payload_length=length,
                       compressed=bool(flags & RLE), **fields)
            if kind == DATA:
                self.on_data(payload)
            self.previous = fields
            self.expected_offset = (offset + len(payload)) & MASK32
            self.resync = False

    def finish(self):
        if self.pending:
            self.event('partial_transport_packet', hex=self.pending.hex())
            self.pending.clear()
