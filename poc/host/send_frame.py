#!/usr/bin/env python3
"""Send one 128x64 frame to display_write_test firmware over USB CDC.

Requires isolated/cooperating original controller, verified logic voltages, and
OLED D/C connected to GP9. A static screen alone does not meet these conditions.
Never flashes firmware; never retries a write automatically.
"""
import argparse
import fcntl
import os
from pathlib import Path
import select
import termios
import time
import tty
import zlib

from usb_probe import find_running_ports

HELLO = b'DISPLAY_WRITE_TEST 1 DI=10 CLK=11 CS=12 DC=9'


def write_all(fd, payload, timeout=3):
    deadline = time.monotonic() + timeout
    remaining = memoryview(payload)
    while remaining:
        wait = deadline - time.monotonic()
        if wait <= 0 or not select.select([], [fd], [], wait)[1]:
            raise TimeoutError('USB send timed out; no automatic retry')
        try:
            size = os.write(fd, remaining)
        except BlockingIOError:
            continue
        if size == 0:
            raise OSError('USB closed during send')
        remaining = remaining[size:]


def read_line(fd, timeout=3):
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while len(buf) <= 256:
        wait = deadline - time.monotonic()
        if wait <= 0 or not select.select([fd], [], [], wait)[0]:
            raise TimeoutError('USB reply timed out')
        try:
            chunk = os.read(fd, 1)
        except BlockingIOError:
            continue
        if not chunk:
            raise OSError('USB disconnected')
        if chunk == b'\n':
            return bytes(buf).rstrip(b'\r')
        buf.extend(chunk)
    raise ValueError('Unexpected firmware response')


def send_frame(dev, frame):
    if len(frame) != 1024:
        raise ValueError('Frame must be exactly 1024 bytes')
    fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
    original = None
    writing = False
    try:
        # Do not share a serial port with live_mirror or another reader.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if hasattr(termios, 'TIOCEXCL'):
            fcntl.ioctl(fd, termios.TIOCEXCL)
        original = termios.tcgetattr(fd)
        tty.setraw(fd)
        termios.tcflush(fd, termios.TCIOFLUSH)
        write_all(fd, b'HELLO\n')
        if read_line(fd) != HELLO:
            raise ValueError('Expected display_write_test v1; no frame sent')
        crc = zlib.crc32(frame)
        request = f'WRITE1 {crc:08x} {frame.hex()}\n'.encode('ascii')
        writing = True
        write_all(fd, request)
        reply = read_line(fd, timeout=5)
        expected = f'DONE 1024 {crc:08x} HIGH_Z'.encode('ascii')
        if reply != expected:
            raise ValueError(f'Firmware reply: {reply.decode("ascii", errors="replace")}')
        return reply.decode('ascii')
    except Exception as error:
        if writing:
            raise RuntimeError(
                f'{error}; write outcome may be uncertain. No retry was sent; inspect the display before rerunning.'
            ) from error
        raise
    finally:
        if original is not None:
            try:
                termios.tcsetattr(fd, termios.TCSANOW, original)
            except OSError:
                pass  # A disconnected USB device may no longer accept termios.
        if hasattr(termios, 'TIOCNXCL'):
            try:
                fcntl.ioctl(fd, termios.TIOCNXCL)
            except OSError:
                pass
        os.close(fd)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('frame', type=Path, nargs='?', default=Path('_output/write-test/naoge.bin'))
    ap.add_argument('--port', help='USB CDC device; otherwise require one Display Write Test device')
    ap.add_argument('--dry-run', action='store_true', help='validate frame without opening any device')
    args = ap.parse_args()
    try:
        frame = args.frame.read_bytes()
        if len(frame) != 1024:
            raise ValueError('Frame must be exactly 1024 bytes, page-major, bit0 at top')
        print(f'{args.frame}: 128x64, 1024 bytes, CRC32 {zlib.crc32(frame):08x}')
        if args.dry_run:
            print('Dry run: no device opened, no data sent')
            return 0
        dev = args.port
        if dev is None:
            ports = [port for name, vid, port in find_running_ports() if 'Display Write Test' in name]
            if len(ports) != 1:
                raise ValueError('Require exactly one Display Write Test device, or supply --port; passive firmware cannot write')
            dev = ports[0]
        print(send_frame(dev, frame))
        print('One frame clocked out; GPIO returned to input. Verify the OLED visually.')
        return 0
    except (OSError, ValueError, TimeoutError, RuntimeError) as error:
        ap.exit(1, f'{error}\n')


if __name__ == '__main__':
    raise SystemExit(main())
