#!/usr/bin/env python3
"""Render an ENS-font display test locally; never open a serial port or GPIO.

Requires ImageMagick for font rasterization. Output includes a 128x64 page-packed
frame, preview, synthetic mirror replay, and a conditional SSD1306 transaction
plan. That plan is not evidence that the attached display supports these writes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from photo_reference import pack_pages, read_pgm


W, H = 128, 64


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--font', type=Path,
                    default=Path.home() / 'Library/Fonts/ENSFont.ttc')
    ap.add_argument('--text', default='腦哥')
    ap.add_argument('--out', type=Path, default=Path('_output/write-test/naoge'))
    args = ap.parse_args()
    magick = shutil.which('magick')
    if not magick or not args.font.is_file() or not args.text.strip():
        ap.error('Require ImageMagick, an existing font file, and nonempty text')

    # Render large, trim the ink bounds, then fit uniformly without stretching.
    # Threshold only after reduction so strokes are sampled at panel resolution.
    with tempfile.TemporaryDirectory(prefix='display-test-') as tmp:
        panel = Path(tmp) / 'panel.pgm'
        subprocess.run([
            magick, '-background', 'black', '-fill', 'white',
            '-font', str(args.font.resolve()), '-pointsize', '1024',
            'label:' + args.text, '-trim', '+repage', '-resize', f'{W}x{H}',
            '-gravity', 'center', '-background', 'black', '-extent', f'{W}x{H}',
            '-threshold', '50%', '-depth', '8', str(panel),
        ], check=True)
        width, height, pixels = read_pgm(panel.read_bytes())
        if (width, height) != (W, H) or not set(pixels) <= {0, 255}:
            raise ValueError('Expected a monochrome 128x64 raster')
        rows = [[int(pixels[y * W + x] != 0) for x in range(W)] for y in range(H)]
        frame = pack_pages(rows)
        if len(frame) != 1024 or not any(frame):
            raise ValueError('Expected a nonblank 1024-byte frame')
        args.out.parent.mkdir(parents=True, exist_ok=True)
        def output(suffix):
            return Path(str(args.out) + suffix)
        subprocess.run([magick, str(panel), str(output('.png'))], check=True)
        subprocess.run([magick, str(panel), '-filter', 'point', '-resize', '800%',
                        str(output('.preview.png'))], check=True)

    output('.bin').write_bytes(frame)
    # Reproduce the observed byte grammar for OFFLINE mirror verification only.
    # D/C and electrical timing are deliberately not represented by this file.
    replay = b''.join(bytes([0xB0 + page]) + frame[page * W:(page + 1) * W]
                      for page in range(H // 8))
    output('.replay.hex').write_text('\n'.join(
        replay[i:i + 32].hex() for i in range(0, len(replay), 32)) + '\n')

    # Standard SSD1306 page mode: select mode, then page + column zero + pixels.
    # Leave oscillator, contrast, power, and scan direction settings untouched.
    transactions = [{'dc': 0, 'hex': '2002', 'purpose': 'select page addressing'}]
    for page in range(H // 8):
        transactions.extend([
            {'dc': 0, 'hex': bytes([0xB0 + page, 0x00, 0x10]).hex(),
             'purpose': f'page {page}, column 0'},
            {'dc': 1, 'hex': frame[page * W:(page + 1) * W].hex(),
             'purpose': f'page {page} pixels'},
        ])
    plan = {
        'profile': 'ssd1306-compatible, unverified on attached hardware',
        'status': 'offline candidate; not transmitted',
        'preconditions': [
            'original controller isolated or verified to release the bus',
            'logic voltages and interface timing verified',
            'D/C wired and actual controller/addressing confirmed',
            'panel already initialized and display enabled',
            'CS and handoff timing implemented separately',
        ],
        'transactions': transactions,
    }
    output('.transactions.json').write_text(json.dumps(plan, indent=2) + '\n')
    lit = [(x, y) for y, row in enumerate(rows) for x, value in enumerate(row) if value]
    metadata = {
        'text': args.text, 'font': str(args.font.resolve()),
        'font_sha256': hashlib.sha256(args.font.read_bytes()).hexdigest(),
        'size': [W, H], 'bytes': len(frame),
        'ink_bounds_exclusive': [min(x for x, y in lit), min(y for x, y in lit),
                                 max(x for x, y in lit) + 1, max(y for x, y in lit) + 1],
        'packing': 'page-major, byte[page*128+x], bit0 = top pixel',
        'frame_sha256': hashlib.sha256(frame).hexdigest(),
        'render': '1024pt, trimmed, uniform fit to 128x64, centered, 50% threshold',
        'transmitted': False,
    }
    output('.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    print(f'Created {args.out}.bin / .png / .preview.png / .replay.hex / .transactions.json / .json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
