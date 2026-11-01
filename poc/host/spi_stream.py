"""STP2 binary transport: CRC-checked packets and explicit continuity tracking.

USB packet/read boundaries have no display meaning. Only a device loss epoch,
sequence/offset discontinuity, restart, or transport corruption breaks assembly.
"""
import struct
import zlib

MAGIC = b'STP2'
HEADER = struct.Struct('<4sBBHIIIIII')
MAX_PAYLOAD = 256
DATA, STATUS, SESSION_START = 1, 2, 1
MASK32 = 0xffffffff


class StreamParser:
    def __init__(self, on_data, on_gap, diagnostics=None):
        self.on_data = on_data
        self.on_gap = on_gap
        self.diagnostics = diagnostics
        self.pending = bytearray()
        self.previous = None
        self.expected_offset = None
        self.resync = False

    def event(self, kind, **details):
        if self.diagnostics is not None:
            self.diagnostics(kind, **details)

    def feed(self, chunk):
        self.pending.extend(chunk)
        while True:
            start = self.pending.find(MAGIC)
            if start < 0:
                count = max(0, len(self.pending) - len(MAGIC) + 1)
                if count:
                    self.event('transport_noise', hex=self.pending[:count].hex())
                    del self.pending[:count]
                    self.resync = True
                return
            if start:
                self.event('transport_noise', hex=self.pending[:start].hex())
                del self.pending[:start]
                self.resync = True
            if len(self.pending) < HEADER.size:
                return
            magic, kind, flags, length, seq, stamp, offset, epoch, dropped, stalls = HEADER.unpack_from(self.pending)
            if (kind not in (DATA, STATUS) or flags & ~SESSION_START or length > MAX_PAYLOAD
                    or (kind == STATUS and length) or (kind == DATA and not length)):
                self.event('transport_bad_header', hex=self.pending[:HEADER.size].hex())
                del self.pending[:1]
                self.resync = True
                continue
            total = HEADER.size + length + 4
            if len(self.pending) < total:
                return
            body = self.pending[:HEADER.size + length]
            crc = struct.unpack_from('<I', self.pending, HEADER.size + length)[0]
            if zlib.crc32(body) != crc:
                self.event('transport_bad_crc', sequence=seq, hex=self.pending[:total].hex())
                del self.pending[:1]
                self.resync = True
                continue
            payload = bytes(self.pending[HEADER.size:HEADER.size + length])
            del self.pending[:total]
            fields = dict(packet_type=kind, flags=flags, sequence=seq, device_us=stamp,
                          device_offset=offset, loss_epoch=epoch,
                          dropped_total=dropped, stall_events=stalls)
            reasons = []
            if self.resync:
                reasons.append('transport-resync')
            if flags & SESSION_START:
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
            self.event('stream_packet', payload_length=length, **fields)
            if kind == DATA:
                self.on_data(payload)
            self.previous = fields
            self.expected_offset = (offset + length) & MASK32
            self.resync = False

    def finish(self):
        if self.pending:
            self.event('partial_transport_packet', hex=self.pending.hex())
            self.pending.clear()
