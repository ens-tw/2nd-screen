#!/usr/bin/env python3
"""Find photo-reference page candidates in a saved SPI hex capture.

Reports masked pixel Hamming distances and neighboring bytes for investigation.
Matches are candidates, not command/data classification or proof of frame sync.
Use --shift-x/--shift-y to test the photo's uncertain canvas margins.
"""
import argparse
import heapq
import json
from pathlib import Path

from raster import load_bytes, W, H, FRAME


def shift_reference(frame, mask, dx, dy):
    out, valid = bytearray(FRAME), bytearray(FRAME)
    for y in range(H):
        for x in range(W):
            sx, sy = x - dx, y - dy
            if 0 <= sx < W and 0 <= sy < H:
                src, bit = (sy // 8) * W + sx, sy % 8
                dst, dbit = (y // 8) * W + x, y % 8
                out[dst] |= ((frame[src] >> bit) & 1) << dbit
                valid[dst] |= ((mask[src] >> bit) & 1) << dbit
    return bytes(out), bytes(valid)


def compare_pages(capture, reference, mask, count=3):
    # Integers make a full 128-byte masked comparison one XOR + bit_count.
    result = []
    for page in range(H // 8):
        start = page * W
        target = int.from_bytes(reference[start:start + W], 'little')
        valid = int.from_bytes(mask[start:start + W], 'little')
        tested, lit = valid.bit_count(), (target & valid).bit_count()
        record = {'reference_page': page, 'compared_bits': tested, 'lit_bits': lit}
        if min(lit, tested - lit) < 8:
            record['skipped'] = 'Too few lit or dark reference bits to locate this page'
        else:
            best = heapq.nsmallest(count, (
                (((int.from_bytes(capture[i:i + W], 'little') ^ target) & valid).bit_count(), i)
                for i in range(max(0, len(capture) - W + 1))))
            record['candidates'] = [
                {'payload_offset': i, 'bit_errors': errors,
                 'error_fraction': errors / tested,
                 'preceding_bytes': capture[max(0, i - 8):i].hex(),
                 'following_bytes': capture[i + W:i + W + 8].hex()}
                for errors, i in best]
        result.append(record)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('capture', type=Path, help='usb_probe.py hex capture')
    ap.add_argument('reference', type=Path, help='photo_reference.py .bin (128x64)')
    ap.add_argument('--mask', type=Path, help='photo_reference.py .mask.bin')
    ap.add_argument('--shift-x', type=int, default=0)
    ap.add_argument('--shift-y', type=int, default=0)
    ap.add_argument('--candidates', type=int, default=3)
    args = ap.parse_args()
    if args.candidates < 1 or abs(args.shift_x) >= W or abs(args.shift_y) >= H:
        ap.error('Require positive candidate count and shifts smaller than the canvas')
    capture = load_bytes(args.capture)
    reference = args.reference.read_bytes()
    mask = args.mask.read_bytes() if args.mask else b'\xff' * FRAME
    if len(reference) != FRAME or len(mask) != FRAME:
        ap.error('Reference and mask must each contain exactly 1024 bytes')
    if len(capture) < W:
        ap.error('Need at least 128 captured bytes')
    reference, mask = shift_reference(reference, mask, args.shift_x, args.shift_y)
    print(json.dumps({'capture_bytes': len(capture),
                      'shift': [args.shift_x, args.shift_y],
                      'caveat': 'Page matches are independent candidates; photo margins, '
                                'orientation, wire bit order and protocol remain to be verified. '
                                'Offsets refer to decoded bus bytes, not hex text characters.',
                      'pages': compare_pages(capture, reference, mask, args.candidates)}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
