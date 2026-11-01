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

    def test_refresh_commands_decode_observed_clock_values_and_offsets(self):
        for value in (0x6f, 0x7f, 0x8f, 0x9f):
            prefix = bytes([0xd5, value, 0x81, 0xff, 0xa6, 0xc0, 0xa0])
            commands = mirror.decode_refresh_prefix(prefix, 50)
            self.assertEqual([c['bus_offset'] for c in commands], [50, 52, 54, 55, 56])
            self.assertEqual(b''.join(bytes.fromhex(c['hex']) for c in commands), prefix)
            self.assertEqual(commands[0]['decoded'], {'clock_divider': 16, 'oscillator_setting': value >> 4})
            self.assertEqual(commands[0]['parameters'], [value])
            self.assertEqual(commands[1]['decoded'], {'contrast': 255})
            self.assertEqual(commands[2]['decoded'], {'inverted': False})
            self.assertEqual(commands[3]['decoded'], {'direction': 'ascending'})
            self.assertEqual(commands[4]['decoded'], {'remapped': False})
        changed = mirror.decode_refresh_prefix(bytes.fromhex('d523817fa7c8a1'), 0)
        self.assertEqual(changed[0]['decoded'], {'clock_divider': 4, 'oscillator_setting': 2})
        self.assertEqual(changed[1]['decoded'], {'contrast': 127})
        self.assertTrue(changed[2]['decoded']['inverted'])
        self.assertEqual(changed[3]['decoded']['direction'], 'descending')
        self.assertTrue(changed[4]['decoded']['remapped'])

    def test_known_commands_are_annotated_once_and_not_left_unmatched(self):
        events = []
        decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
        prefix = bytes.fromhex('d56f81ffa6c0a0')
        wire = prefix + encode_frame(self.frame)
        ingest(decoder, wire)
        ingest(decoder, b'\x01\x02')  # Extra reads must not repeat annotations for the old frame.
        decoder.finish()
        records = [e for kind, e in events if kind == 'display_commands']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['frame_bus_offset'], 7)
        self.assertEqual(len(records[0]['commands']), 13)
        pages = records[0]['commands'][5:]
        self.assertEqual([c['decoded']['page'] for c in pages], list(range(8)))
        self.assertEqual([c['bus_offset'] for c in pages], [7 + page * 129 for page in range(8)])
        extras = [e for kind, e in events if kind == 'unmatched_bus_bytes']
        self.assertEqual([(e['bus_offset'], e['hex']) for e in extras], [(len(wire), '0102')])
        self.assertEqual(decoder.frame, self.frame)

    def test_commands_wait_for_full_frame_and_never_cross_a_gap(self):
        prefix = bytes.fromhex('d57f81ffa6c0a0')
        for gap in (False, True):
            events = []
            decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
            ingest(decoder, prefix)
            self.assertFalse(any(kind == 'display_commands' for kind, _ in events))
            if gap:
                decoder.break_stream('loss-epoch')
            ingest(decoder, encode_frame(self.frame)[:-1])
            self.assertFalse(any(kind == 'display_commands' for kind, _ in events))
            ingest(decoder, encode_frame(self.frame)[-1:])
            decoder.finish()
            records = [e for kind, e in events if kind == 'display_commands']
            self.assertEqual(len(records), 1)
            self.assertEqual(len(records[0]['commands']), 8 if gap else 13)
            extras = [e for kind, e in events if kind == 'unmatched_bus_bytes']
            self.assertEqual(b''.join(bytes.fromhex(e['hex']) for e in extras), prefix if gap else b'')

    def test_command_like_pixels_are_never_reclassified(self):
        prefix = bytes.fromhex('d58f81ffa6c0a0')
        frame = bytearray(self.frame)
        frame[:7] = frame[-7:] = prefix
        events = []
        decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
        # The next frame has no prefix. Its preceding seven bytes are the previous frame's pixels.
        ingest(decoder, encode_frame(frame) + encode_frame(self.frame))
        decoder.finish()
        records = [e for kind, e in events if kind == 'display_commands']
        self.assertEqual(len(records), 2)
        self.assertTrue(all(len(e['commands']) == 8 for e in records))
        self.assertEqual(decoder.frame, self.frame)

    def test_unknown_or_truncated_prefixes_stay_in_unmatched_log(self):
        for prefix in (bytes.fromhex('d58f81ffa5c0a0'), bytes.fromhex('81ffa6c0a0'),
                       bytes.fromhex('d58f81ffa6c0a2')):
            events = []
            decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
            ingest(decoder, prefix + encode_frame(self.frame))
            decoder.finish()
            records = [e for kind, e in events if kind == 'display_commands']
            self.assertEqual(len(records[0]['commands']), 8)
            extras = [e for kind, e in events if kind == 'unmatched_bus_bytes']
            self.assertEqual(b''.join(bytes.fromhex(e['hex']) for e in extras), prefix)

    def test_repeated_pixels_still_log_changed_command_parameters(self):
        events = []
        decoder = mirror.MirrorDecoder(diagnostics=lambda kind, **data: events.append((kind, data)))
        for value in (0x6f, 0x9f):
            ingest(decoder, bytes([0xd5, value, 0x81, 0xff, 0xa6, 0xc0, 0xa0]) + encode_frame(self.frame))
        records = [e for kind, e in events if kind == 'display_commands']
        self.assertEqual(len(records), 2)
        self.assertEqual([e['commands'][0]['parameters'] for e in records], [[0x6f], [0x9f]])
        self.assertEqual(decoder.revision, 1)

    def test_raw_view_never_labels_bytes_as_display_commands(self):
        events = []
        decoder = mirror.MirrorDecoder(False, lambda kind, **data: events.append((kind, data)))
        ingest(decoder, bytes.fromhex('d56f81ffa6c0a0') + encode_frame(self.frame))
        self.assertFalse(any(kind == 'display_commands' for kind, _ in events))


if __name__ == '__main__':
    unittest.main()
