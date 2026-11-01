#!/usr/bin/env python3
# Live screen mirror (the PoC's main effect): passive SPI capture -> live ASCII
# reproduction of the eval board's display.
# ---------------------------------------------------------------------------
# Takes the real bus bytes spi_tap streams continuously over USB CDC, rebuilds the
# framebuffer as they arrive, and **redraws in place** as a 128x64 ASCII "screen" in
# the terminal. Switch screens on the eval board and this follows almost in sync.
# This is the PoC goal from docs/2nd-screen.md: show that passively tapping four
# wires is enough to watch what is on the display.
# Pixel mirroring only; contains no content-interpretation logic.
#
# Compare: raster.py = single static reconstruction (from a file);
#          this file = live streaming mirror.
#          Both share the same vertical-column-packing reconstruction.
#
# Usage (run in your own terminal; the in-place redraw needs a real TTY):
#   1) Flash spi_tap first (continuous DMA + binary streaming):
#        picotool load -x -f poc/build/spi-tap/spi_tap.uf2
#   2) python3 poc/host/live_mirror.py              # connect to the board, mirror live, Ctrl-C to quit
#      python3 poc/host/live_mirror.py --page       # page-sequence mode (the default)
#      python3 poc/host/live_mirror.py --raw        # latest 1024 bytes, explicitly unaligned
#      python3 poc/host/live_mirror.py --file cap.txt  # no board, replay a capture file (for verification)
#      python3 poc/host/live_mirror.py --seconds 20  # exit after a fixed time (static output when not a TTY)
#      python3 poc/host/live_mirror.py --capture _output/pin-test.txt  # exact input + diagnostic events
# Standard library only; autodetects STP2 binary packets and legacy hex captures.
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import select
import sys
import time
import tty
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usb_probe import find_running_ports          # noqa: E402  (tool in the same directory)
from raster import render_frame, FRAME, W, H       # noqa: E402
from spi_stream import MAGIC, StreamParser        # noqa: E402

RECENT = 4096          # enough for several complete page sequences
PAGE_STRIDE = W + 1    # measured capture: one page opcode, then 128 pixel bytes
PAGE_FRAME = (H // 8) * PAGE_STRIDE
RENDER_INTERVAL = 1 / 30  # coalesce terminal updates without the old 6.7 Hz cap
_HEX_RE = re.compile(rb'(?:[0-9a-fA-F]{2}){1,32}')

# ── Terminal control sequences (real TTY only) ──
_ALT_ON, _ALT_OFF = "\x1b[?1049h", "\x1b[?1049l"
_CUR_OFF, _CUR_ON = "\x1b[?25l", "\x1b[?25h"
_HOME = "\x1b[H"
_OLED, _RST = "\x1b[97m", "\x1b[0m"

def latest_frame(buf):
    """Raw diagnostic view; its origin is unknown, but it cannot favor old density."""
    return bytes(buf[-FRAME:]) if len(buf) >= FRAME else None


def page_frame(buf):
    """Newest complete B0..B7 sequence with exactly 128 payload bytes per page.

    The observed stream has no column-address bytes between a page marker and
    its payload. Never skip low-valued pixels. Requiring all eight markers at
    their expected offsets avoids treating an isolated pixel byte as a command.
    Display remapping/orientation still needs comparison with the physical panel.
    """
    match = find_page_frame(buf)
    return match[1] if match is not None else None


def find_page_frame(buf):
    """Return the newest complete sequence's offset and framebuffer."""
    for off in range(len(buf) - PAGE_FRAME, -1, -1):
        if all(buf[off + page * PAGE_STRIDE] == 0xB0 + page
               for page in range(H // 8)):
            return off, b''.join(buf[off + page * PAGE_STRIDE + 1:
                                off + (page + 1) * PAGE_STRIDE]
                            for page in range(H // 8))
    return None


def make_frame(buf, use_page=True):
    return page_frame(buf) if use_page else latest_frame(buf)


def feed_hex(line_bytes, acc):
    """Accept only a whole firmware hex line (1..32 bytes); return bytes added."""
    line = line_bytes.strip()
    if not _HEX_RE.fullmatch(line):
        return 0
    data = bytes.fromhex(line.decode('ascii'))
    acc.extend(data)
    return len(data)


def decode_refresh_prefix(prefix, bus_offset):
    """Recognize the observed control-prefix grammar, never arbitrary pixel bytes.

    Call only immediately before a validated full B0..B7 frame, outside a
    previously recognized frame. Names/fields follow the SSD1306-compatible
    command table, not a verified controller identity:
    https://www.orientdisplay.com/wp-content/uploads/2020/11/SSD1306.pdf#page=32
    """
    if (len(prefix) != 7 or prefix[0] != 0xD5 or prefix[2] != 0x81
            or prefix[4] not in (0xA6, 0xA7) or prefix[5] not in (0xC0, 0xC8)
            or prefix[6] not in (0xA0, 0xA1)):
        return None
    specs = [
        (0, 2, 'set_display_clock',
         {'clock_divider': (prefix[1] & 0x0F) + 1, 'oscillator_setting': prefix[1] >> 4}),
        (2, 2, 'set_contrast', {'contrast': prefix[3]}),
        (4, 1, 'set_display_mode', {'inverted': prefix[4] == 0xA7}),
        (5, 1, 'set_com_scan_direction',
         {'direction': 'ascending' if prefix[5] == 0xC0 else 'descending'}),
        (6, 1, 'set_segment_remap', {'remapped': prefix[6] == 0xA1}),
    ]
    return [dict(bus_offset=bus_offset + offset, length=length,
                 hex=prefix[offset:offset + length].hex(), opcode=prefix[offset],
                 command=name, parameters=list(prefix[offset + 1:offset + length]),
                 decoded=decoded)
            for offset, length, name, decoded in specs]


class CaptureLog:
    """Exact serial input plus timestamped decoder decisions; never overwrite."""

    def __init__(self, path=None, source='live'):
        if path is None:
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            path = (Path(__file__).resolve().parents[2] / '_output' / 'captures'
                    / f'mirror-{stamp}-{uuid.uuid4().hex[:6]}.txt')
        self.path = Path(path)
        self.events_path = Path(str(self.path) + '.events.jsonl')
        if self.path.exists() or self.events_path.exists():
            raise FileExistsError(f'Capture already exists: {self.path} or {self.events_path}')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.raw = self.path.open('xb')
        try:
            self.events = self.events_path.open('x')
        except OSError:
            self.raw.close()
            raise
        self.start = time.monotonic()
        self.serial_bytes = 0
        self.event('capture_start', utc=datetime.now(timezone.utc).isoformat(),
                   raw_path=str(self.path), source=source,
                   note='Raw serial input before filtering; bytes never sent by firmware are unavailable.')

    def event(self, kind, **details):
        record = {'event': kind, 'elapsed_ms': round((time.monotonic() - self.start) * 1000, 3),
                  **details}
        self.events.write(json.dumps(record) + '\n')
        self.events.flush()

    def write(self, chunk):
        # Save before parsing, including malformed text and partial serial lines.
        offset = self.serial_bytes
        self.raw.write(chunk)
        self.raw.flush()
        self.serial_bytes += len(chunk)
        self.event('serial_chunk', serial_offset=offset, length=len(chunk))

    def close(self):
        try:
            self.event('capture_end', serial_bytes=self.serial_bytes)
        finally:
            self.raw.close()
            self.events.close()


class MirrorDecoder:
    """Keep complete frames across reads, but never assemble across dump gaps."""

    def __init__(self, use_page=True, diagnostics=None):
        self.use_page = use_page
        self.diagnostics = diagnostics
        self.pending = bytearray()
        self.covered = bytearray()
        self.pending_offset = 0
        self.last_span = None
        self.frame = None
        self.revision = 0
        self.received = 0

    def event(self, kind, **details):
        if self.diagnostics is not None:
            self.diagnostics(kind, **details)

    def discard(self, count, reason):
        """Archive bytes not accounted for by a selected frame or known commands."""
        start = 0
        while start < count:
            if self.covered[start]:
                start += 1
                continue
            end = start + 1
            while end < count and not self.covered[end]:
                end += 1
            self.event('unmatched_bus_bytes', bus_offset=self.pending_offset + start,
                       length=end - start, hex=self.pending[start:end].hex(), reason=reason)
            start = end
        del self.pending[:count]
        del self.covered[:count]
        self.pending_offset += count

    def finish(self):
        self.discard(len(self.pending), 'end-of-input')

    def break_stream(self, reason):
        self.discard(len(self.pending), reason)

    def feed_line(self, line):
        data = bytearray()
        if not feed_hex(line, data):
            reason = 'dump-boundary' if not line.strip() else 'non-hex-line'
            self.break_stream(reason)
            self.event(reason, after_bus_offset=self.received, serial_line_hex=line.hex())
            return
        self.feed_bus(data)

    def feed_bus(self, data):
        # Binary USB chunks are contiguous across reads; only reported loss resets.
        self.pending.extend(data)
        self.received += len(data)
        self.covered.extend(b'\x00' * len(data))
        if len(self.pending) > RECENT:
            self.discard(len(self.pending) - RECENT, 'buffer-limit')
        match = find_page_frame(self.pending) if self.use_page else None
        if self.use_page:
            offset, frame = match if match is not None else (0, None)
            length = PAGE_FRAME
        else:
            frame = latest_frame(self.pending)
            offset, length = len(self.pending) - FRAME, FRAME
        if frame is not None:
            self.covered[offset:offset + length] = b'\x01' * length
            span = (self.pending_offset + offset, length)
            if span != self.last_span:
                if self.use_page:
                    commands = []
                    if offset >= 7 and not any(self.covered[offset - 7:offset]):
                        prefix = decode_refresh_prefix(self.pending[offset - 7:offset], span[0] - 7)
                        if prefix is not None:
                            commands.extend(prefix)
                            self.covered[offset - 7:offset] = b'\x01' * 7
                    for page in range(H // 8):
                        opcode = 0xB0 + page
                        commands.append(dict(bus_offset=span[0] + page * PAGE_STRIDE,
                                             length=1, hex=f'{opcode:02x}', opcode=opcode,
                                             command='set_page_start_address', parameters=[],
                                             decoded={'page': page}))
                    self.event('display_commands', profile='ssd1306-compatible',
                               recognition='validated-frame-boundary',
                               frame_bus_offset=span[0], commands=commands)
                self.event('frame_candidate', bus_offset=span[0], length=length,
                           changed=frame != self.frame, mode=mode_label(self.use_page))
                self.last_span = span
        if frame is not None and frame != self.frame:
            self.frame = frame
            self.revision += 1


class CaptureInput:
    """Autodetect new binary streams and preserve legacy hex-file replay."""

    def __init__(self, decoder):
        self.decoder = decoder
        self.mode = None
        self.pending = bytearray()
        self.stream = StreamParser(decoder.feed_bus, decoder.break_stream, decoder.diagnostics)

    def feed(self, chunk):
        if self.mode == 'binary':
            self.stream.feed(chunk)
            return
        self.pending.extend(chunk)
        if self.mode is None:
            if MAGIC in self.pending or len(self.pending) > 4096:
                self.mode = 'binary'
                self.decoder.event('transport_detected', mode=self.mode)
                self.stream.feed(self.pending)
                self.pending.clear()
                return
            if b"\n" not in self.pending:
                return
            line = self.pending.partition(b"\n")[0]
            try:
                text = line.decode('utf-8')
            except UnicodeDecodeError:
                return
            if not all(char.isprintable() or char in '\t\r' for char in text):
                return
            self.mode = 'legacy-hex'
            self.decoder.event('transport_detected', mode=self.mode)
        while b"\n" in self.pending:
            line, _, self.pending = self.pending.partition(b"\n")
            self.decoder.feed_line(line)

    def finish(self, replay=False):
        if self.mode == 'binary':
            self.stream.finish()
        elif self.pending:
            if replay:
                self.decoder.feed_line(self.pending)
            else:
                self.decoder.event('partial_serial_line', hex=self.pending.hex())
            self.pending.clear()


def mode_label(use_page):
    return 'page-sequence B0..B7' if use_page else 'RAW UNALIGNED (latest 1024B)'


def box(art, status, color=True):
    label = " DOT-MATRIX EVAL BOARD  128x64  — passive bus mirror "
    top = "┌" + label + "─" * (W - len(label)) + "┐"
    lines = [top]
    for ln in art.split("\n"):
        body = (_OLED + ln + _RST) if color else ln
        lines.append("│" + body + "│")
    lines.append("└" + "─" * W + "┘")
    lines.append(status)
    return "\n".join(lines) + "\n"

def report_capture(capture):
    print(f'Raw capture: {capture.path}\nDecoder events: {capture.events_path}', file=sys.stderr)


def run_live(dev, use_page=True, seconds=0.0, capture_path=None):
    terminal = sys.stdout.isatty()
    try:
        fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        if os.isatty(fd):
            tty.setraw(fd)  # binary bytes must bypass echo, CR/LF conversion and IXON
    except OSError as e:
        print(f"Cannot open {dev}: {e}")
        return 1
    try:
        capture = CaptureLog(capture_path)
    except OSError as error:
        os.close(fd)
        print(f'Cannot save capture: {error}')
        return 1
    report_capture(capture)
    decoder = MirrorDecoder(use_page, capture.event)
    reader = CaptureInput(decoder)
    deadline = (time.monotonic() + seconds) if seconds else None
    last_render, frames, rendered_revision = 0.0, 0, -1
    if terminal:
        sys.stdout.write(_ALT_ON + _CUR_OFF)
        sys.stdout.flush()
    try:
        while deadline is None or time.monotonic() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                capture.write(chunk)
                reader.feed(chunk)
            now = time.monotonic()
            if (now - last_render >= RENDER_INTERVAL and decoder.frame is not None
                    and decoder.revision != rendered_revision):
                art = render_frame(decoder.frame)
                frames += 1
                status = (f"updates={frames}  received={decoder.received}B  "
                          f"{mode_label(use_page)}  (Ctrl-C to quit)")
                if terminal:
                    sys.stdout.write(_HOME + box(art, status, color=True))
                else:
                    sys.stdout.write("\n" + box(art, status, color=False))
                sys.stdout.flush()
                capture.event('render', revision=decoder.revision, received_bus_bytes=decoder.received)
                last_render = now
                rendered_revision = decoder.revision
    except KeyboardInterrupt:
        pass
    finally:
        try:
            reader.finish()
            decoder.finish()
        finally:
            try:
                capture.close()
            finally:
                os.close(fd)
                if terminal:
                    sys.stdout.write(_CUR_ON + _ALT_OFF)
                    sys.stdout.flush()
                report_capture(capture)
    if frames == 0:
        print("No complete frame. Switch screens to generate bus activity. "
              "Page mode requires B0..B7 with 128 bytes per page; "
              "--raw shows an unaligned diagnostic view.")
        return 1
    return 0


def run_file(path, use_page=True, capture_path=None):
    capture = None
    decoder = MirrorDecoder(use_page)
    reader = CaptureInput(decoder)
    try:
        with open(path, 'rb') as source:
            capture = CaptureLog(capture_path, source='replay') if capture_path is not None else None
            decoder = MirrorDecoder(use_page, capture.event if capture is not None else None)
            reader = CaptureInput(decoder)
            while chunk := source.read(4096):
                if capture is not None:
                    capture.write(chunk)
                reader.feed(chunk)
    except OSError as error:
        print(f"Cannot read {path}: {error}")
        return 1
    finally:
        try:
            reader.finish(replay=True)
            decoder.finish()
        finally:
            if capture is not None:
                capture.close()
                report_capture(capture)
    if decoder.frame is None:
        print(f"# No complete frame in {decoder.received} captured bytes. "
              "Expected B0..B7 with 128 bytes per page; "
              "--raw shows an unaligned diagnostic view.")
        return 1
    print(box(render_frame(decoder.frame),
              f"{decoder.received}B  {mode_label(use_page)}  (file replay)",
              color=sys.stdout.isatty()))
    return 0


def main():
    parser = argparse.ArgumentParser(description='Passive SPI screen mirror')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--page', action='store_true', help='page-sequence mode (default)')
    modes.add_argument('--raw', action='store_true', help='latest 1024 bytes, without alignment')
    parser.add_argument('--file', help='replay a saved hex capture')
    parser.add_argument('--capture', help='save exact serial input and .events.jsonl; live default: _output/captures/')
    parser.add_argument('--seconds', type=float, default=0, help='live duration; 0 means unlimited')
    args = parser.parse_args()
    if not math.isfinite(args.seconds) or args.seconds < 0:
        parser.error('--seconds must be finite and nonnegative')
    use_page = not args.raw
    if args.file:
        return run_file(args.file, use_page, args.capture)

    ports = find_running_ports()
    if not ports:
        print("No RP2040 serial port found. Check that the board is running spi_tap (usb_probe.py reports RUNNING).")
        return 1
    return run_live(ports[0][2], use_page, args.seconds, args.capture)

if __name__ == "__main__":
    sys.exit(main())
