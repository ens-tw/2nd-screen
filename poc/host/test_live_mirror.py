"""Regression checks for byte parsing, page sync and live/replay behavior."""
import contextlib
import io
import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import live_mirror as mirror


def encode_frame(frame):
    return b''.join(bytes([0xb0 + page]) + frame[page * 128:(page + 1) * 128]
                    for page in range(8))


def dump_lines(data):
    return [data[i:i + 32].hex().encode() + b'\r\n' for i in range(0, len(data), 32)]


def ingest(decoder, data):
    for line in dump_lines(data):
        decoder.feed_line(line)


class MirrorTests(unittest.TestCase):
    def setUp(self):
        self.frame = random.Random(19).randbytes(1024)

    def test_banner_and_malformed_lines_add_no_bytes(self):
        acc = bytearray()
        for line in (b'# spi_tap ready (DI=GP10 CLK=GP11 CS=GP12) -- no decode',
                     b'frames=12 deadbeef', b'abc', b'0x12', b'00' * 33,
                     b'12 34', b'\xff\x0012', b'', b'\r\n'):
            self.assertEqual(mirror.feed_hex(line, acc), 0)
        self.assertEqual(acc, b'')
        self.assertEqual(mirror.feed_hex(b' 00aABbFF\r\n', acc), 4)
        self.assertEqual(acc, bytes.fromhex('00aabbff'))

    def test_page_payload_zeros_low_values_and_markers_are_preserved(self):
        frame = bytearray(self.frame)
        for page in range(8):
            frame[page * 128:page * 128 + 8] = bytes([0, 0, 0x10, 0x1f, 0xb0, 0xb7, 0, 1])
        self.assertEqual(mirror.page_frame(b'\xa6\xc0\xa0' + encode_frame(frame)), frame)

    def test_requires_every_page_and_complete_final_payload(self):
        wire = encode_frame(self.frame)
        self.assertIsNone(mirror.page_frame(wire[:-1]))
        self.assertIsNone(mirror.page_frame(b'\xb0' + self.frame))
        corrupt = bytearray(wire)
        corrupt[4 * 129] = 0xb5
        self.assertIsNone(mirror.page_frame(corrupt))

    def test_capture_started_midframe_reacquires_at_next_page_zero(self):
        wire = encode_frame(self.frame)
        self.assertEqual(mirror.page_frame(wire[370:] + b'\xa6\xc0\xa0' + wire), self.frame)

    def test_new_blank_frame_replaces_old_dense_frame(self):
        wire = encode_frame(b'\xff' * 1024) + encode_frame(b'\x00' * 1024)
        self.assertEqual(mirror.make_frame(wire), b'\x00' * 1024)
        self.assertEqual(mirror.latest_frame(b'\xff' * 1024 + b'\x00' * 1024), b'\x00' * 1024)

    def test_incomplete_refresh_keeps_previous_complete_frame(self):
        decoder = mirror.MirrorDecoder()
        ingest(decoder, encode_frame(self.frame))
        revision = decoder.revision
        ingest(decoder, encode_frame(b'\x00' * 1024)[:-16])
        self.assertEqual(decoder.frame, self.frame)
        self.assertEqual(decoder.revision, revision)
        ingest(decoder, encode_frame(b'\x00' * 1024)[-16:])
        self.assertEqual(decoder.frame, b'\x00' * 1024)

    def test_gap_or_banner_prevents_assembling_a_spliced_frame(self):
        wire = encode_frame(self.frame)
        for separator in (b'\r\n', b'# spi_tap ready DI=GP10\n', b'123\n'):
            decoder = mirror.MirrorDecoder()
            ingest(decoder, wire[:-16])
            decoder.feed_line(separator)
            ingest(decoder, wire[-16:])
            self.assertIsNone(decoder.frame)
            decoder.feed_line(b'\n')
            ingest(decoder, wire)
            self.assertEqual(decoder.frame, self.frame)

    def test_duplicate_frame_does_not_increase_redraw_revision(self):
        decoder = mirror.MirrorDecoder()
        ingest(decoder, encode_frame(self.frame))
        revision = decoder.revision
        ingest(decoder, encode_frame(self.frame))
        self.assertEqual(decoder.revision, revision)

    def test_raw_is_explicit_and_page_mode_does_not_fall_back(self):
        self.assertIsNone(mirror.make_frame(b'\xff' * 1024))
        self.assertEqual(mirror.make_frame(b'\xff' * 1024, False), b'\xff' * 1024)
        self.assertIsNone(mirror.latest_frame(b'\x00' * 1023))
        self.assertIn('UNALIGNED', mirror.mode_label(False))

    def test_replay_default_and_raw_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'capture.txt'
            path.write_bytes(b'# ready GP10 GP11 GP12\n' + b''.join(dump_lines(encode_frame(self.frame))) + b'\n')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(mirror.run_file(path), 0)
            self.assertIn('1032B  page-sequence', out.getvalue())
            self.assertIn(mirror.render_frame(self.frame).splitlines()[0], out.getvalue())
            path.write_bytes(b''.join(dump_lines(self.frame)))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(mirror.run_file(path), 1)
                self.assertEqual(mirror.run_file(path, False), 0)

    def test_live_fragmented_serial_reads_and_eof(self):
        # Deliberately split within a hex byte and between CR/LF. No real USB access.
        raw = b'# spi_tap ready GP10 GP11 GP12\n' + b''.join(dump_lines(encode_frame(self.frame))) + b'\n'
        chunks = [raw[i:i + 17] for i in range(0, len(raw), 17)] + [b'']
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(mirror.os, 'open', return_value=55), \
                patch.object(mirror.os, 'read', side_effect=chunks), \
                patch.object(mirror.os, 'close') as close, \
                patch.object(mirror.select, 'select', return_value=([55], [], [])), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            path = Path(directory) / 'live.txt'
            self.assertEqual(mirror.run_live('/fake/serial', capture_path=path), 0)
            self.assertEqual(path.read_bytes(), raw)
        close.assert_called_once_with(55)
        self.assertIn('received=1032B', out.getvalue())
        self.assertIn(mirror.render_frame(self.frame).splitlines()[0], out.getvalue())

    def test_extra_bytes_are_saved_with_original_bus_offsets(self):
        events = []
        decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
        prefix = b'\xa6\xc0\xa0'
        partial = b'\xb7' + b'\0' * 40
        ingest(decoder, prefix + encode_frame(self.frame) + partial)
        decoder.feed_line(b'\n')
        decoder.finish()
        extras = [event for kind, event in events if kind == 'unmatched_bus_bytes']
        self.assertEqual([(event['bus_offset'], bytes.fromhex(event['hex'])) for event in extras],
                         [(0, prefix), (len(prefix) + 1032, partial)])
        self.assertTrue(all(event['reason'] == 'dump-boundary' for event in extras))
        frames = [event for kind, event in events if kind == 'frame_candidate']
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]['bus_offset'], len(prefix))
        self.assertEqual(frames[0]['length'], 1032)

    def test_unmatched_evicted_and_final_bytes_are_all_archived(self):
        events = []
        decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
        data = b'\x10\x20' * (mirror.RECENT + 200)
        ingest(decoder, data)
        self.assertLessEqual(len(decoder.pending), mirror.RECENT)
        decoder.finish()
        extras = [event for kind, event in events if kind == 'unmatched_bus_bytes']
        rebuilt = b''.join(bytes.fromhex(event['hex']) for event in extras)
        self.assertEqual(rebuilt, data)
        offset = 0
        for event in extras:
            self.assertEqual(event['bus_offset'], offset)
            offset += event['length']
        self.assertEqual(offset, len(data))

    def test_replay_log_is_lossless_even_for_ignored_and_partial_input(self):
        raw = (b'# banner GP10 GP11 GP12\r\n' + b''.join(dump_lines(encode_frame(self.frame)))
               + b'\r\ninvalid: deadbeef\r\n' + b''.join(dump_lines(b'\xb7\0\0')) + b'a')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.txt'
            saved = Path(directory) / 'saved.txt'
            source.write_bytes(raw)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(mirror.run_file(source, capture_path=saved), 0)
            self.assertEqual(saved.read_bytes(), raw)
            events = [json.loads(line) for line in Path(str(saved) + '.events.jsonl').read_text().splitlines()]
        self.assertEqual(events[0]['source'], 'replay')
        self.assertEqual(events[-1]['serial_bytes'], len(raw))
        self.assertTrue(any(event['event'] == 'non-hex-line' for event in events))
        self.assertTrue(any(event['event'] == 'unmatched_bus_bytes' for event in events))
        times = [event['elapsed_ms'] for event in events]
        self.assertEqual(times, sorted(times))

    def test_live_partial_line_saved_even_when_no_frame_decodes(self):
        raw = b'# banner\r\n00ff\r\n\r\n123'
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(mirror.os, 'open', return_value=55), \
                patch.object(mirror.os, 'read', side_effect=[raw, b'']), \
                patch.object(mirror.os, 'close'), \
                patch.object(mirror.select, 'select', return_value=([55], [], [])), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            saved = Path(directory) / 'partial.txt'
            self.assertEqual(mirror.run_live('/fake/serial', capture_path=saved), 1)
            self.assertEqual(saved.read_bytes(), raw)
            events = [json.loads(line) for line in Path(str(saved) + '.events.jsonl').read_text().splitlines()]
        self.assertTrue(any(event['event'] == 'partial_serial_line' and event['hex'] == b'123'.hex()
                            for event in events))

    def test_capture_never_overwrites_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'capture.txt'
            path.write_bytes(b'previous input')
            with self.assertRaises(FileExistsError):
                mirror.CaptureLog(path)
            self.assertEqual(path.read_bytes(), b'previous input')
            other = Path(directory) / 'other.txt'
            Path(str(other) + '.events.jsonl').write_text('previous diagnostics')
            with self.assertRaises(FileExistsError):
                mirror.CaptureLog(other)
            self.assertFalse(other.exists())


if __name__ == '__main__':
    unittest.main()
