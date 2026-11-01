#!/usr/bin/env python3
"""Sample a photographed pixel grid into a reference framebuffer, without OCR.

PGM input needs only Python's standard library. Other formats (including HEIC)
are decoded locally by ImageMagick's `magick`. Coordinates are in the decoded
image: --origin is the CENTER of canvas pixel (0, 0), not the panel boundary.
This produces a visual reference, NOT a measured SPI transaction.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def read_pgm(raw):
    """Read binary PGM, preserving whitespace-valued first raster samples."""
    pos = 0
    tokens = []
    while len(tokens) < 4:
        while pos < len(raw) and raw[pos] in b' \t\r\n':
            pos += 1
        if pos < len(raw) and raw[pos] == ord('#'):
            pos = raw.index(b'\n', pos) + 1
            continue
        start = pos
        while pos < len(raw) and raw[pos] not in b' \t\r\n':
            pos += 1
        tokens.append(raw[start:pos])
    if tokens[0] != b'P5' or tokens[3] != b'255':
        raise ValueError('Expected an 8-bit binary PGM (P5, maxval 255)')
    if pos >= len(raw):
        raise ValueError('Missing PGM raster separator')
    pos += 2 if raw[pos:pos + 2] == b'\r\n' else 1
    width, height = int(tokens[1]), int(tokens[2])
    pixels = raw[pos:]
    if width <= 0 or height <= 0 or len(pixels) != width * height:
        raise ValueError('Invalid PGM raster size')
    return width, height, pixels


def load_image(path):
    if path.suffix.lower() == '.pgm':
        return read_pgm(path.read_bytes()), 'PGM input'
    magick = shutil.which('magick')
    if not magick:
        raise ValueError('Use an 8-bit PGM, or install ImageMagick to decode this image')
    result = subprocess.run([magick, str(path.resolve()), '-colorspace', 'gray',
                             '-depth', '8', 'pgm:-'], check=True, capture_output=True)
    return read_pgm(result.stdout), 'ImageMagick grayscale decode'


def pack_pages(rows):
    """Page-major; each byte is a column with its top pixel in bit 0."""
    height, width = len(rows), len(rows[0])
    return bytes(sum(rows[page * 8 + bit][x] << bit for bit in range(8))
                 for page in range(height // 8) for x in range(width))


def sample_grid(image, size, origin, pitch, shear, threshold, radius, margin):
    width, height, pixels = image
    rows, masks = [], []
    for y in range(size[1]):
        row, mask = [], []
        for x in range(size[0]):
            px = round(origin[0] + x * pitch[0])
            py = round(origin[1] + y * pitch[1] + shear * x * pitch[0])
            if not (radius <= px < width - radius and radius <= py < height - radius):
                raise ValueError(f'Grid pixel ({x}, {y}) samples outside the photograph')
            values = [pixels[(py + j) * width + px + i]
                      for j in range(-radius, radius + 1)
                      for i in range(-radius, radius + 1)]
            value = sum(values) / len(values)
            row.append(int(value >= threshold))
            mask.append(int(abs(value - threshold) >= margin))
        rows.append(row)
        masks.append(mask)
    return rows, masks


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('image', type=Path)
    ap.add_argument('--out', type=Path, required=True, help='output filename prefix')
    ap.add_argument('--origin', nargs=2, type=float, required=True, metavar=('X', 'Y'))
    ap.add_argument('--pitch', nargs=2, type=float, required=True, metavar=('DX', 'DY'))
    ap.add_argument('--shear', type=float, default=0, help='photo Y change per photo X')
    ap.add_argument('--size', nargs=2, type=int, default=(128, 64), metavar=('W', 'H'))
    ap.add_argument('--threshold', type=float, default=130)
    ap.add_argument('--radius', type=int, default=2, help='average a (2r+1)-square patch')
    ap.add_argument('--margin', type=float, default=30, help='exclude uncertain brightness from mask')
    args = ap.parse_args()
    if (min(args.size) <= 0 or args.size[1] % 8 or min(args.pitch) <= 0
            or args.radius < 0 or not 0 <= args.threshold <= 255 or args.margin < 0):
        ap.error('Require positive size/pitch, height divisible by 8, and valid sampling parameters')
    try:
        image, decoder = load_image(args.image)
        rows, masks = sample_grid(image, args.size, args.origin, args.pitch, args.shear,
                                  args.threshold, args.radius, args.margin)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        ap.error(str(error))
    frame, mask = pack_pages(rows), pack_pages(masks)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    def write(suffix, data):
        path = Path(str(args.out) + suffix)
        if isinstance(data, bytes):
            path.write_bytes(data)
        else:
            path.write_text(data)
    write('.bin', frame)
    write('.mask.bin', mask)
    write('.hex', '\n'.join(frame[i:i + 32].hex() for i in range(0, len(frame), 32)) + '\n')
    write('.bits.txt', '\n'.join(''.join(map(str, row)) for row in rows) + '\n')
    # PBM uses 1 for black; preview uses 255 for a lit display pixel.
    write('.pbm', 'P1\n%d %d\n' % tuple(args.size)
          + '\n'.join(' '.join(str(1 - bit) for bit in row) for row in rows) + '\n')
    scale = 8
    preview = b''.join(bytes(bit * 255 for bit in row for _ in range(scale)) * scale for row in rows)
    write('.preview.pgm', ('P5\n%d %d\n255\n' % (args.size[0] * scale, args.size[1] * scale)).encode() + preview)
    metadata = {
        'source': str(args.image.resolve()), 'sha256': hashlib.sha256(args.image.read_bytes()).hexdigest(),
        'decoder': decoder, 'image_size': image[:2], 'size': args.size,
        'origin_center': args.origin, 'pitch': args.pitch, 'shear': args.shear,
        'threshold': args.threshold, 'radius': args.radius, 'confidence_margin': args.margin,
        'packing': 'page-major: byte[page*width+x], bit0 = top of 8-pixel column',
        'bytes': len(frame), 'confident_pixels': sum(b.bit_count() for b in mask),
        'caveat': 'Photo-derived reference. Canvas origin and panel margins are unverified; '
                  'mask records brightness certainty only, not geometric accuracy. '
                  'No SPI command, wire bit order, or display addressing has been measured here.'
    }
    write('.json', json.dumps(metadata, indent=2) + '\n')
    print(f'{len(frame)} bytes -> {args.out}.bin / .hex / .bits.txt / .pbm')
    print(metadata['caveat'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
