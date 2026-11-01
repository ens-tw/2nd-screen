"""Binary transport checks, including the firmware C encoder on the host CPU."""
import random
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

from live_mirror import MirrorDecoder, make_stream
from spi_stream import (COMPACT_HEADER, COMPACT_MAGIC, COMPACT_OVERHEAD, DATA, RLE, SESSION_START,
                        STATUS, STATUS_HEADER, STATUS_MAGIC, StreamParser,
                        compact_packet, rle_encode, rle_decode)
from test_live_mirror import encode_frame


def status(seq=0, offset=0, epoch=1, dropped=0, stalls=0, flags=0):
    body = STATUS_HEADER.pack(STATUS_MAGIC, STATUS, flags, 0, seq, 12345, offset, epoch, dropped, stalls)
    return body + struct.pack('<I', zlib.crc32(body))


def compact_wire(wire, seq=0, offset=0, flags=0):
    """A compact packet with an exact wire payload, for malformed-input cases."""
    body = COMPACT_HEADER.pack(COMPACT_MAGIC, flags, seq & 0xff, len(wire), offset & 0xffff) + wire
    return body + struct.pack('<I', zlib.crc32(body))


def compile_and_run(source, stdin=b''):
    include = Path(__file__).resolve().parents[1] / 'rp2040-spi-tap'
    with tempfile.TemporaryDirectory() as directory:
        cfile, exe = Path(directory) / 'encoder.c', Path(directory) / 'encoder'
        cfile.write_text(source)
        subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(include),
                        str(cfile), '-o', str(exe)], check=True, capture_output=True)
        return subprocess.run([str(exe)], input=stdin, check=True, capture_output=True).stdout


class StreamTests(unittest.TestCase):
    def make_parser(self):
        self.data, self.gaps, self.events = [], [], []
        return StreamParser(self.data.append, self.gaps.append,
                            lambda kind, **details: self.events.append((kind, details)))

    def test_fragmented_packets_deliver_every_binary_value(self):
        parser = self.make_parser()
        payload = bytes(range(256))
        wire = status(flags=SESSION_START) + compact_packet(payload, 1, 0)
        for value in wire:
            parser.feed(bytes([value]))
        self.assertEqual(self.data, [payload])
        self.assertEqual(self.gaps, ['session-start'])
        self.assertEqual(parser.previous['sequence'], 1)

    def test_whole_frame_in_one_packet_rebuilds_after_status(self):
        pixels = random.Random(7).randbytes(1024)
        bus = encode_frame(pixels)
        decoder = MirrorDecoder()
        reader = make_stream(decoder)
        wire = status(flags=SESSION_START) + compact_packet(bus, 1, 0)
        for i in range(0, len(wire), 113):
            reader.feed(wire[i:i + 113])
        self.assertEqual(decoder.frame, pixels)

    def test_frame_survives_short_tail_and_status_between_chunks(self):
        frame = random.Random(98).randbytes(1024)
        wire = encode_frame(frame)
        decoder = MirrorDecoder()
        reader = make_stream(decoder)
        reader.feed(status(flags=SESSION_START))
        offset, seq = 0, 1
        for i in range(0, len(wire), 256):
            part = wire[i:i + 256]
            reader.feed(compact_packet(part, seq, offset))
            offset += len(part)
            seq += 1
            reader.feed(status(seq=seq, offset=offset))
            seq += 1
        self.assertEqual(decoder.frame, frame)
        self.assertEqual(decoder.received, len(wire))

    def test_crc_error_resynchronizes_and_never_delivers_corrupt_payload(self):
        parser = self.make_parser()
        damaged = bytearray(compact_packet(b'wrong payload', 0, 0))
        damaged[-1] ^= 1
        parser.feed(b'noise' + damaged + compact_packet(b'right', 2, 13))
        self.assertEqual(self.data, [b'right'])
        self.assertTrue(any('transport-resync' in gap for gap in self.gaps))
        self.assertTrue(any(kind == 'transport_bad_crc' for kind, _ in self.events))

    def test_header_length_corruption_is_bounded(self):
        parser = self.make_parser()
        oversized = COMPACT_MAGIC + struct.pack('<BBHH', 0, 0, 2049, 0)
        parser.feed(oversized + compact_packet(b'next', 1, 0))
        self.assertEqual(self.data, [b'next'])
        self.assertEqual(self.gaps, ['transport-resync'])
        self.assertTrue(any(kind == 'transport_bad_header' for kind, _ in self.events))

    def test_status_with_payload_or_rle_flag_is_rejected(self):
        for flags, length in ((RLE, 0), (0, 4)):
            with self.subTest(flags=flags, length=length):
                parser = self.make_parser()
                bad = STATUS_HEADER.pack(STATUS_MAGIC, STATUS, flags, length, 0, 0, 0, 1, 0, 0)
                parser.feed(bad + b'\x00' * (length + 4) + compact_packet(b'next', 1, 0))
                self.assertEqual(self.data, [b'next'])
                self.assertTrue(any(kind == 'transport_bad_header' for kind, _ in self.events))

    def test_stp2_data_packets_are_rejected(self):
        parser = self.make_parser()
        body = STATUS_HEADER.pack(STATUS_MAGIC, DATA, 0, 4, 0, 12345, 0, 1, 0, 0) + b'old!'
        parser.feed(body + struct.pack('<I', zlib.crc32(body)) + compact_packet(b'next', 1, 4))
        self.assertEqual(self.data, [b'next'])

    def test_sequence_and_offset_gaps_are_detected(self):
        for name, wire, reason in (('sequence', compact_packet(b'efgh', 3, 4), 'packet-sequence'),
                                   ('offset', compact_packet(b'efgh', 2, 9), 'byte-offset')):
            with self.subTest(name):
                parser = self.make_parser()
                parser.feed(status(seq=0) + compact_packet(b'abcd', 1, 0) + wire)
                self.assertEqual(self.gaps, [reason])
                self.assertEqual(self.data, [b'abcd', b'efgh'])

    def test_every_continuity_break_discards_the_partial_frame(self):
        wire = encode_frame(random.Random(1).randbytes(1024))
        for name, next_packets in (('sequence', compact_packet(wire[256:512], 7, 256)),
                                   ('offset', compact_packet(wire[256:512], 2, 600)),
                                   ('epoch', status(seq=2, offset=256, epoch=2) + compact_packet(wire[256:512], 3, 256)),
                                   ('drop', status(seq=2, offset=256, dropped=20) + compact_packet(wire[256:512], 3, 256)),
                                   ('stall', status(seq=2, offset=256, stalls=1) + compact_packet(wire[256:512], 3, 256))):
            with self.subTest(name):
                decoder = MirrorDecoder()
                reader = make_stream(decoder)
                reader.feed(status(seq=0))
                reader.feed(compact_packet(wire[:256], 1, 0))
                reader.feed(next_packets)
                # The first fragment must have been removed on any continuity error.
                self.assertEqual(bytes(decoder.pending), wire[256:512])
                self.assertIsNone(decoder.frame)

    def test_counters_wrap_without_gaps(self):
        parser = self.make_parser()
        parser.feed(status(seq=0xfe, offset=0xfffe))
        parser.feed(compact_packet(b'abcd', 0xff, 0xfffe))
        parser.feed(compact_packet(b'efgh', 0x100, 0x10002))
        self.assertEqual(self.gaps, [])
        self.assertEqual(parser.previous['sequence'], 0x100)
        self.assertEqual(parser.expected_offset, 0x10006)

    def test_32_bit_counters_wrap_without_gaps(self):
        parser = self.make_parser()
        parser.feed(status(seq=0xfffffffe, offset=0xfffffffe))
        parser.feed(compact_packet(b'ab', 0xffffffff, 0xfffffffe))
        parser.feed(compact_packet(b'cd', 0, 0))
        self.assertEqual(self.gaps, [])
        self.assertEqual(self.data, [b'ab', b'cd'])
        self.assertEqual(parser.previous['sequence'], 0)

    def test_data_inherits_state_and_status_change_breaks_the_stream(self):
        parser = self.make_parser()
        parser.feed(status(seq=0, epoch=9, dropped=3, stalls=1))
        parser.feed(compact_packet(b'abcd', 1, 0))
        self.assertEqual(self.gaps, [])
        self.assertEqual((parser.previous['loss_epoch'], parser.previous['dropped_total'],
                          parser.previous['stall_events']), (9, 3, 1))
        self.assertIsNone(parser.previous['device_us'])
        parser.feed(status(seq=2, offset=500, epoch=10, dropped=496, stalls=1))
        self.assertEqual(self.gaps, ['byte-offset,loss-epoch,ring-drop'])

    def test_unknown_prefix_and_partial_packet_are_preserved_as_events(self):
        parser = self.make_parser()
        parser.feed(b'junk' + compact_packet(b'good', 0, 0) + COMPACT_MAGIC + b'\x01')
        parser.finish()
        self.assertEqual(self.data, [b'good'])
        self.assertTrue(any(kind == 'partial_transport_packet' for kind, _ in self.events))

    def test_rle_boundaries_and_every_byte_round_trip(self):
        rng = random.Random(48)
        for size in (1, 2, 3, 4, 5, 127, 128, 129, 130, 131, 255, 256, 257, 1039, 2048):
            for data in (b'\x00' * size, b'\xff' * size, rng.randbytes(size),
                         (bytes(range(256)) * 8)[:size], (b'aaabbbcc' * 256)[:size]):
                with self.subTest(size=size, data=data[:8]):
                    self.assertEqual(rle_decode(struct.pack('<H', len(data)) + rle_encode(data)), data)

    def test_rle_rejects_original_length_above_the_limit(self):
        with self.assertRaises(ValueError):
            rle_decode(struct.pack('<H', 2049) + rle_encode(b'\x00' * 2049))

    def test_mixed_raw_rle_and_status_use_original_byte_offsets(self):
        parser = self.make_parser()
        wire = (status(seq=0)
                + compact_packet(b'\x00' * 256, 1, 0)
                + compact_packet(b'raw data', 2, 256)
                + status(seq=3, offset=264)
                + compact_packet(b'\xff' * 256, 4, 264))
        for i in range(0, len(wire), 7):
            parser.feed(wire[i:i + 7])
        self.assertEqual(self.data, [b'\x00' * 256, b'raw data', b'\xff' * 256])
        self.assertEqual(self.gaps, [])
        self.assertEqual(parser.expected_offset, 520)
        records = [f for kind, f in self.events if kind == 'stream_packet']
        self.assertEqual(records[1]['payload_length'], 256)
        self.assertEqual(records[1]['wire_payload_length'], 6)
        self.assertTrue(records[1]['compressed'])
        self.assertFalse(records[2]['compressed'])

    def test_incompressible_and_tiny_payloads_stay_raw(self):
        parser = self.make_parser()
        noise = random.Random(11).randbytes(1500)
        wire = compact_packet(noise, 0, 0) + compact_packet(b'\xd5', 1, 1500)
        parser.feed(wire)
        self.assertEqual(self.data, [noise, b'\xd5'])
        self.assertEqual(self.gaps, [])
        self.assertEqual(wire[2], 0)

    def test_compression_stats_count_every_data_packet_and_ignore_heartbeats(self):
        parser = self.make_parser()
        small = compact_packet(b'x', 0, 0)
        heartbeat = status(seq=1, offset=1)
        large = compact_packet(b'\x00' * 2048, 2, 1)
        parser.feed(small + heartbeat + large)
        stats = parser.compression.summary()
        self.assertEqual(COMPACT_OVERHEAD, 12)
        self.assertEqual(stats['data_packets'], 2)
        self.assertEqual(stats['original_packet_bytes'], 13 + 12 + 2048)
        self.assertEqual(stats['wire_packet_bytes'], len(small) + len(large))
        self.assertEqual(stats['min_saved_percent'], 0)
        self.assertAlmostEqual(stats['max_saved_percent'], 100 * (1 - len(large) / (12 + 2048)))
        self.assertAlmostEqual(stats['avg_saved_percent'],
                               100 * (1 - (len(small) + len(large)) / (13 + 12 + 2048)))

    def test_bad_packets_do_not_affect_compression_stats(self):
        parser = self.make_parser()
        bad_crc = bytearray(compact_packet(b'\x00' * 256, 0, 0))
        bad_crc[-1] ^= 1
        parser.feed(bad_crc + compact_wire(b'bad', seq=1, flags=RLE))
        stats = parser.compression.summary()
        self.assertEqual(stats['data_packets'], 0)
        self.assertIsNone(stats['min_saved_percent'])
        self.assertIsNone(stats['max_saved_percent'])
        self.assertIsNone(stats['avg_saved_percent'])

    def test_invalid_rle_is_bounded_and_next_packet_is_independent(self):
        malformed = [b'\x00\x00\x80x', b'\x01\x08\x80x', b'\x03\x00\x80',
                     b'\x04\x00\x03x', b'\x02\x00\x80x', b'\x04\x00\x80x',
                     b'\x01\x00\x00x\x00y']
        for payload in malformed:
            with self.subTest(payload=payload):
                parser = self.make_parser()
                parser.feed(compact_wire(payload, flags=RLE)
                            + compact_packet(b'\xff' * 256, 1, 256))
                self.assertEqual(self.data, [b'\xff' * 256])
                self.assertTrue(any(k == 'transport_bad_compression' for k, _ in self.events))
                self.assertEqual(self.gaps, ['transport-resync'])

    def test_rle_crc_failure_does_not_poison_next_packet(self):
        parser = self.make_parser()
        damaged = bytearray(compact_packet(b'\x00' * 256, 0, 0))
        damaged[-1] ^= 1
        parser.feed(damaged + compact_packet(b'\xff' * 256, 1, 256))
        self.assertEqual(self.data, [b'\xff' * 256])
        self.assertTrue(any(k == 'transport_bad_crc' for k, _ in self.events))

    def test_sequence_gap_discards_partial_frame_and_recovers(self):
        pixels = b'\x00' * 1024
        bus = encode_frame(pixels)
        decoder = MirrorDecoder()
        reader = make_stream(decoder)
        reader.feed(status(seq=0))
        reader.feed(compact_packet(bus[:256], 1, 0))
        reader.feed(compact_packet(bus[256:512], 3, 256))
        self.assertIsNone(decoder.frame)
        reader.feed(status(seq=4, offset=512))
        reader.feed(compact_packet(bus, 5, 512))
        self.assertEqual(decoder.frame, pixels)

    @unittest.skipUnless(shutil.which('cc'), 'native C compiler required')
    def test_c_compact_packets_match_reference_and_parser(self):
        source = r'''
#include <stdio.h>
#include "stream_protocol.h"
static uint8_t input[TAP_COMPACT_MAX_PAYLOAD], out[TAP_COMPACT_PACKET_SIZE];
int main(void) {
    uint8_t size[2];
    uint32_t sequence = 250, offset = 65000;
    while (fread(size, 1, 2, stdin) == 2) {
        uint16_t n = (uint16_t)(size[0] | size[1] << 8);
        if (n > TAP_COMPACT_MAX_PAYLOAD || fread(input, 1, n, stdin) != n) return 2;
        size_t used = tap_compact_packet(out, input, n, sequence++, offset);
        if (!used || used > n + 12u || fwrite(out, 1, used, stdout) != used) return 3;
        offset += n;
    }
    return tap_compact_packet(out, input, 0, 0, 0) || tap_compact_packet(out, input, 2049, 0, 0);
}
'''
        rng = random.Random(2027)
        cases = [b'\xd5', b'\x00' * 4, b'\x00' * 5, b'\x00' * 2048, rng.randbytes(2048),
                 encode_frame(rng.randbytes(1024)), encode_frame(b'\x00' * 1024)]
        for size in (2, 3, 6, 127, 128, 129, 130, 131, 255, 256, 257, 1039, 2047):
            cases.extend((rng.randbytes(size), b'x' * size,
                          bytes(rng.choice((0, 0, 0, 255, 48)) for _ in range(size))))
        wire = compile_and_run(source, b''.join(struct.pack('<H', len(d)) + d for d in cases))
        expected, offset = bytearray(), 65000
        for seq, data in enumerate(cases, 250):
            expected.extend(compact_packet(data, seq, offset))
            offset += len(data)
        self.assertEqual(wire, expected)
        parser = self.make_parser()
        parser.feed(status(seq=249, offset=65000))
        for i in range(0, len(wire), 113):
            parser.feed(wire[i:i + 113])
        self.assertEqual(b''.join(self.data), b''.join(cases))
        self.assertEqual(self.gaps, [])

    @unittest.skipUnless(shutil.which('cc'), 'native C compiler required')
    def test_c_status_packet_matches_python_parser(self):
        source = r'''
#include <stdio.h>
#include "stream_protocol.h"
int main(void) {
    uint8_t out[TAP_STATUS_PACKET_SIZE];
    size_t n = tap_status_packet(out, TAP_SESSION_START, 12, 12345, 777, 4, 19, 2);
    return fwrite(out, 1, n, stdout) == n ? 0 : 1;
}
'''
        wire = compile_and_run(source)
        self.assertEqual(wire, status(seq=12, offset=777, epoch=4, dropped=19, stalls=2,
                                      flags=SESSION_START))
        parser = self.make_parser()
        parser.feed(wire)
        self.assertEqual(self.gaps, ['session-start'])
        self.assertEqual(parser.previous['dropped_total'], 19)


if __name__ == '__main__':
    unittest.main()
