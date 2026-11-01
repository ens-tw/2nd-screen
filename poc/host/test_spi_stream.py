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
from spi_stream import DATA, HEADER, MAGIC, SESSION_START, STATUS, StreamParser
from test_live_mirror import encode_frame, dump_lines


def packet(payload=b'', seq=0, offset=0, epoch=1, dropped=0, stalls=0, flags=0):
    body = HEADER.pack(MAGIC, DATA if payload else STATUS, flags, len(payload),
                       seq, 12345, offset, epoch, dropped, stalls) + payload
    return body + struct.pack('<I', zlib.crc32(body))


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
