#!/usr/bin/env python3
"""Measure packet RLE on an STP2 capture and verify lossless mirror replay.

Offline only. --seconds supplies the original capture duration for byte rates.
An optional --out writes a new compressed capture, never overwriting a file.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile
import zlib

from live_mirror import MirrorDecoder
from spi_stream import HEADER, MAGIC, DATA, SESSION_START, RLE, StreamParser, rle_encode


def benchmark(path, seconds=None, out=None):
    stats = dict(packets=0, compressed_packets=0, bus_bytes=0,
                 original_packet_bytes=0, compressed_packet_bytes=0, source_errors=0)
    original_hash, decoded_hash = hashlib.sha256(), hashlib.sha256()
    original_frames, decoded_frames = [], []
    def frame_events(target):
        return lambda kind, **fields: target.append((fields['bus_offset'], fields['changed'])) \
            if kind == 'frame_candidate' else None
    original = MirrorDecoder(diagnostics=frame_events(original_frames))
    decoded = MirrorDecoder(diagnostics=frame_events(decoded_frames))
    state = dict(fields=None, reset=False)
    decode_errors = []

    def decoded_data(payload):
        decoded_hash.update(payload)
        decoded.feed_bus(payload)

    def decoded_event(kind, **fields):
        if kind.startswith('transport_bad_'):
            decode_errors.append(kind)
    compressed_parser = StreamParser(decoded_data, decoded.break_stream, decoded_event)

    with tempfile.TemporaryFile() as converted:
        def transcode(payload, fields):
            encoded = struct.pack('<H', len(payload)) + rle_encode(payload)
            compressed = bool(payload) and len(encoded) < len(payload)
            wire_payload = encoded if compressed else payload
            flags = fields['flags'] & SESSION_START
            if state['reset']:
                flags |= SESSION_START
                state['reset'] = False
            if compressed:
                flags |= RLE
            body = HEADER.pack(MAGIC, fields['packet_type'], flags, len(wire_payload),
                               fields['sequence'], fields['device_us'], fields['device_offset'],
                               fields['loss_epoch'], fields['dropped_total'], fields['stall_events'])
            body += wire_payload
            wire = body + struct.pack('<I', zlib.crc32(body))
            stats['compressed_packets'] += compressed
            stats['compressed_packet_bytes'] += len(wire)
            converted.write(wire)
            # Deliberately break packets across serial-read boundaries.
            for i in range(0, len(wire), 113):
                compressed_parser.feed(wire[i:i + 113])

        def source_gap(reason):
            original.break_stream(reason)
            state['reset'] = True

        def source_data(payload):
            stats['bus_bytes'] += len(payload)
            original_hash.update(payload)
            original.feed_bus(payload)
            transcode(payload, state['fields'])

        def source_event(kind, **fields):
            if kind.startswith('transport_bad_'):
                stats['source_errors'] += 1
            if kind == 'stream_packet':
                stats['packets'] += 1
                stats['original_packet_bytes'] += HEADER.size + fields['wire_payload_length'] + 4
                state['fields'] = fields
                if fields['packet_type'] != DATA:
                    transcode(b'', fields)

        parser = StreamParser(source_data, source_gap, source_event)
        with path.open('rb') as source:
            # Snapshot a live file's current extent, rather than chasing writes.
            remaining = path.stat().st_size
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                parser.feed(chunk)
        if not stats['packets']:
            raise ValueError('No valid STP2 packets; legacy hex is not supported by this benchmark')
        if (decode_errors or original_hash.digest() != decoded_hash.digest()
                or original_frames != decoded_frames or original.frame != decoded.frame):
            raise ValueError('Compressed replay did not match the original')
        stats.update(bus_sha256=original_hash.hexdigest(), frames=len(original_frames),
                     lossless_bus=True, identical_frame_events=True,
                     net_reduction_percent=round(100 * (1 - stats['compressed_packet_bytes'] /
                                                         stats['original_packet_bytes']), 2))
        if seconds is not None:
            stats.update(duration_seconds=seconds,
                         original_Bps=stats['original_packet_bytes'] / seconds,
                         compressed_Bps=stats['compressed_packet_bytes'] / seconds)
        if out is not None:
            out.parent.mkdir(parents=True, exist_ok=True)
            converted.seek(0)
            with out.open('xb') as target:
                shutil.copyfileobj(converted, target)
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('capture', type=Path)
    ap.add_argument('--seconds', type=float)
    ap.add_argument('--out', type=Path)
    args = ap.parse_args()
    if args.seconds is not None and (not math.isfinite(args.seconds) or args.seconds <= 0):
        ap.error('--seconds must be finite and positive')
    try:
        result = benchmark(args.capture, args.seconds, args.out)
    except (OSError, ValueError) as error:
        ap.exit(1, f'{error}\n')
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
