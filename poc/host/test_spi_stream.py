"""Binary transport checks, including the firmware C encoder on the host CPU."""
import random
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib

from live_mirror import CaptureInput, MirrorDecoder
from spi_stream import (DATA, HEADER, MAGIC, SESSION_START, STATUS, RLE,
                        StreamParser, rle_encode, rle_decode)
from test_live_mirror import encode_frame, dump_lines


def packet(payload=b'', seq=0, offset=0, epoch=1, dropped=0, stalls=0, flags=0):
    body = HEADER.pack(MAGIC, DATA if payload else STATUS, flags, len(payload),
                       seq, 12345, offset, epoch, dropped, stalls) + payload
    return body + struct.pack('<I', zlib.crc32(body))


def rle_packet(payload, **fields):
    return packet(struct.pack('<H', len(payload)) + rle_encode(payload), flags=RLE, **fields)


class StreamTests(unittest.TestCase):
    def make_parser(self):
        self.data, self.gaps, self.events = [], [], []
        return StreamParser(self.data.append, self.gaps.append,
                            lambda kind, **details: self.events.append((kind, details)))

    def test_fragmented_packets_deliver_every_binary_value(self):
        parser = self.make_parser()
        payload = bytes(range(256))
        wire = packet(flags=SESSION_START) + packet(payload, seq=1)
        for value in wire:
            parser.feed(bytes([value]))
        self.assertEqual(self.data, [payload])
        self.assertEqual(self.gaps, ['session-start'])
        self.assertEqual(parser.previous['sequence'], 1)

    def test_frame_survives_short_tail_and_status_between_chunks(self):
        frame = random.Random(98).randbytes(1024)
        wire = encode_frame(frame)
        decoder = MirrorDecoder()
        reader = CaptureInput(decoder)
        reader.feed(packet(flags=SESSION_START))
        offset, seq = 0, 1
        for i in range(0, len(wire), 256):
            part = wire[i:i + 256]
            reader.feed(packet(part, seq=seq, offset=offset))
            offset += len(part)
            seq += 1
            reader.feed(packet(seq=seq, offset=offset))
            seq += 1
        self.assertEqual(reader.mode, 'binary')
        self.assertEqual(decoder.frame, frame)
        self.assertEqual(decoder.received, len(wire))

    def test_crc_error_resynchronizes_and_never_delivers_corrupt_payload(self):
        parser = self.make_parser()
        damaged = bytearray(packet(b'wrong STP2 payload'))
        damaged[-1] ^= 1
        parser.feed(b'noise' + damaged + packet(b'right', seq=2))
        self.assertEqual(self.data, [b'right'])
        self.assertTrue(any('transport-resync' in gap for gap in self.gaps))
        self.assertTrue(any(kind == 'transport_bad_crc' for kind, _ in self.events))

    def test_header_length_corruption_is_bounded(self):
        parser = self.make_parser()
        damaged = bytearray(packet(b'payload'))
        damaged[6:8] = b'\xff\xff'
        parser.feed(damaged + packet(b'next', seq=1))
        self.assertEqual(self.data, [b'next'])
        self.assertLess(len(parser.pending), HEADER.size)

    def test_sequence_loss_and_device_loss_break_frame_assembly(self):
        wire = encode_frame(random.Random(1).randbytes(1024))
        for changes in ({'seq': 7}, {'epoch': 2}, {'dropped': 20}, {'stalls': 1}, {'offset': 600}):
            decoder = MirrorDecoder()
            reader = CaptureInput(decoder)
            reader.feed(packet(wire[:256], seq=0))
            params = dict(seq=1, offset=256)
            params.update(changes)
            reader.feed(packet(wire[256:512], **params))
            # The first fragment must have been removed on any continuity error.
            self.assertEqual(bytes(decoder.pending), wire[256:512])
            self.assertIsNone(decoder.frame)

    def test_sequence_and_offset_wrap_are_contiguous(self):
        parser = self.make_parser()
        parser.feed(packet(b'ab', seq=0xffffffff, offset=0xfffffffe))
        parser.feed(packet(b'cd', seq=0, offset=0))
        self.assertEqual(self.gaps, [])
        self.assertEqual(self.data, [b'ab', b'cd'])

    def test_unknown_prefix_and_partial_packet_are_preserved_as_events(self):
        parser = self.make_parser()
        parser.feed(b'junk' + packet(b'good') + MAGIC + b'\x01')
        parser.finish()
        self.assertEqual(self.data, [b'good'])
        self.assertTrue(any(kind == 'partial_transport_packet' for kind, _ in self.events))

    def test_legacy_capture_with_utf8_probe_banner(self):
        frame = random.Random(3).randbytes(1024)
        reader = CaptureInput(MirrorDecoder())
        wire = '狀態：RUNNING\r\n'.encode() + b''.join(dump_lines(encode_frame(frame))) + b'\n'
        for i in range(0, len(wire), 17):
            reader.feed(wire[i:i + 17])
        self.assertEqual(reader.mode, 'legacy-hex')
        self.assertEqual(reader.decoder.frame, frame)

    def test_rle_boundaries_and_every_byte_round_trip(self):
        rng = random.Random(48)
        for size in (1, 2, 3, 4, 5, 127, 128, 129, 130, 131, 255, 256):
            for data in (b'\x00' * size, b'\xff' * size, rng.randbytes(size),
                         bytes(range(256))[:size], (b'aaabbbcc' * 32)[:size]):
                with self.subTest(size=size, data=data[:8]):
                    self.assertEqual(rle_decode(struct.pack('<H', len(data)) + rle_encode(data)), data)

    def test_mixed_raw_rle_and_status_use_original_byte_offsets(self):
        parser = self.make_parser()
        wire = (rle_packet(b'\x00' * 256, seq=0, offset=0)
                + packet(b'raw STP2 data', seq=1, offset=256)
                + packet(seq=2, offset=269)
                + rle_packet(b'\xff' * 256, seq=3, offset=269))
        for i in range(0, len(wire), 7):
            parser.feed(wire[i:i + 7])
        self.assertEqual(self.data, [b'\x00' * 256, b'raw STP2 data', b'\xff' * 256])
        self.assertEqual(self.gaps, [])
        self.assertEqual(parser.expected_offset, 525)
        records = [f for kind, f in self.events if kind == 'stream_packet']
        self.assertEqual(records[0]['payload_length'], 256)
        self.assertEqual(records[0]['wire_payload_length'], 6)
        self.assertTrue(records[0]['compressed'])

    def test_compression_stats_weight_bytes_and_ignore_heartbeats(self):
        parser = self.make_parser()
        parser.feed(packet(b'x', seq=0) + packet(seq=1, offset=1)
                    + rle_packet(b'\x00' * 256, seq=2, offset=1))
        stats = parser.compression.summary()
        self.assertEqual(stats['data_packets'], 2)
        self.assertEqual(stats['original_packet_bytes'], 37 + 292)
        self.assertEqual(stats['wire_packet_bytes'], 37 + 42)
        self.assertAlmostEqual(stats['min_saved_percent'], 100 * (1 - 42 / 292))
        self.assertAlmostEqual(stats['max_saved_percent'], 100 * (1 - 42 / 292))
        self.assertAlmostEqual(stats['avg_saved_percent'], 100 * (1 - 79 / 329))
        self.assertNotAlmostEqual(stats['avg_saved_percent'], stats['max_saved_percent'] / 2)

    def test_min_max_skip_small_packets_at_threshold_but_avg_counts_them(self):
        parser = self.make_parser()
        small = packet(b'\x00' * 127, seq=0)
        at_limit = rle_packet(b'\x00' * 128, seq=1, offset=127)
        parser.feed(small + at_limit)
        stats = parser.compression.summary()
        saved = 100 * (1 - len(at_limit) / (36 + 128))
        self.assertAlmostEqual(stats['min_saved_percent'], saved)
        self.assertAlmostEqual(stats['max_saved_percent'], saved)
        self.assertEqual(stats['data_packets'], 2)
        self.assertEqual(stats['original_packet_bytes'], (36 + 127) + (36 + 128))
        self.assertEqual(stats['wire_packet_bytes'], len(small) + len(at_limit))

    def test_bad_packets_do_not_affect_compression_stats(self):
        parser = self.make_parser()
        bad_crc = bytearray(rle_packet(b'\x00' * 256))
        bad_crc[-1] ^= 1
        parser.feed(bad_crc + packet(b'bad', flags=RLE, seq=1))
        stats = parser.compression.summary()
        self.assertEqual(stats['data_packets'], 0)
        self.assertIsNone(stats['min_saved_percent'])
        self.assertIsNone(stats['max_saved_percent'])
        self.assertIsNone(stats['avg_saved_percent'])

    def test_invalid_rle_is_bounded_and_next_packet_is_independent(self):
        malformed = [b'\x00\x00\x80x', b'\x01\x01\x80x', b'\x03\x00\x80',
                     b'\x04\x00\x03x', b'\x02\x00\x80x', b'\x04\x00\x80x',
                     b'\x01\x00\x00x\x00y']
        for payload in malformed:
            with self.subTest(payload=payload):
                parser = self.make_parser()
                parser.feed(packet(payload, flags=RLE)
                            + rle_packet(b'\xff' * 256, seq=1, offset=256))
                self.assertEqual(self.data, [b'\xff' * 256])
                self.assertTrue(any(k == 'transport_bad_compression' for k, _ in self.events))
                self.assertEqual(self.gaps, ['transport-resync'])

    def test_rle_wire_crc_failure_does_not_poison_next_packet(self):
        parser = self.make_parser()
        damaged = bytearray(rle_packet(b'\x00' * 256))
        damaged[-1] ^= 1
        parser.feed(damaged + rle_packet(b'\xff' * 256, seq=1, offset=256))
        self.assertEqual(self.data, [b'\xff' * 256])
        self.assertTrue(any(k == 'transport_bad_crc' for k, _ in self.events))

    def test_rle_sequence_gap_discards_partial_frame_and_recovers(self):
        pixels = b'\x00' * 1024
        bus = encode_frame(pixels)
        decoder = MirrorDecoder()
        reader = CaptureInput(decoder)
        reader.feed(rle_packet(bus[:256], seq=0, offset=0))
        reader.feed(rle_packet(bus[256:512], seq=2, offset=256))
        self.assertIsNone(decoder.frame)
        reader.feed(packet(seq=3, offset=512))
        seq, offset = 4, 512
        for i in range(0, len(bus), 128):
            chunk = bus[i:i + 128]
            reader.feed(rle_packet(chunk, seq=seq, offset=offset))
            seq += 1
            offset += len(chunk)
        self.assertEqual(decoder.frame, pixels)

    @unittest.skipUnless(shutil.which('cc'), 'native C compiler required')
    def test_c_rle_packets_match_reference_and_never_expand(self):
        source = r'''
#include <stdio.h>
#include "stream_protocol.h"
int main(void) {
    uint8_t input[258], out[TAP_PACKET_SIZE];
    uint32_t sequence = 0, offset = 0;
    while (fread(input, 1, 2, stdin) == 2) {
        uint16_t n = (uint16_t)(input[0] | input[1] << 8);
        if (n > 256 || fread(input, 1, n, stdin) != n) return 2;
        size_t used = tap_packet_auto(out, n ? TAP_DATA : TAP_STATUS, 0,
                                      input, n, sequence++, 12345, offset, 1, 0, 0);
        if (!used || used > n + TAP_HEADER_SIZE + 4 || fwrite(out, 1, used, stdout) != used) return 3;
        offset += n;
    }
    return 0;
}
'''
        rng = random.Random(2026)
        cases = [b'', bytes(range(256)), b'\x00' * 256, b'\xff' * 256]
        for size in range(1, 257):
            cases.extend((rng.randbytes(size), b'x' * size,
                          bytes(rng.choice((0, 0, 0, 255, 48)) for _ in range(size))))
        include = Path(__file__).resolve().parents[1] / 'rp2040-spi-tap'
        with tempfile.TemporaryDirectory() as directory:
            cfile, exe = Path(directory) / 'rle.c', Path(directory) / 'rle'
            cfile.write_text(source)
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-I', str(include), str(cfile), '-o', str(exe)],
                           check=True, capture_output=True)
            wire = subprocess.run([str(exe)], input=b''.join(struct.pack('<H', len(d)) + d for d in cases),
                                  check=True, capture_output=True).stdout
        expected = bytearray()
        offset = 0
        for seq, data in enumerate(cases):
            compressed = struct.pack('<H', len(data)) + rle_encode(data)
            use_rle = len(compressed) < len(data)
            expected.extend(packet(compressed if use_rle else data, flags=RLE if use_rle else 0,
                                   seq=seq, offset=offset))
            offset += len(data)
        self.assertEqual(wire, expected)
        parser = self.make_parser()
        for i in range(0, len(wire), 113):
            parser.feed(wire[i:i + 113])
        self.assertEqual(b''.join(self.data), b''.join(cases))
        self.assertEqual(self.gaps, [])

    @unittest.skipUnless(shutil.which('cc'), 'native C compiler required')
    def test_firmware_c_encoder_matches_python_parser(self):
        source = r'''
#include <stdio.h>
#include "stream_protocol.h"
int main(void) {
    uint8_t payload[256], out[TAP_PACKET_SIZE];
    for (unsigned i = 0; i < 256; i++) payload[i] = (uint8_t)i;
    size_t n = tap_packet(out, TAP_DATA, TAP_SESSION_START, payload, 256,
                          12, 12345, 777, 4, 19, 2);
    return fwrite(out, 1, n, stdout) == n ? 0 : 1;
}
'''
        include = Path(__file__).resolve().parents[1] / 'rp2040-spi-tap'
        with tempfile.TemporaryDirectory() as directory:
            cfile = Path(directory) / 'encoder.c'
            exe = Path(directory) / 'encoder'
            cfile.write_text(source)
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', str(include),
                            str(cfile), '-o', str(exe)], check=True, capture_output=True)
            wire = subprocess.run([str(exe)], check=True, capture_output=True).stdout
        expected = packet(bytes(range(256)), seq=12, offset=777, epoch=4, dropped=19, stalls=2,
                          flags=SESSION_START)
        self.assertEqual(wire, expected)
        parser = self.make_parser()
        parser.feed(wire)
        self.assertEqual(self.data, [bytes(range(256))])


if __name__ == '__main__':
    unittest.main()
