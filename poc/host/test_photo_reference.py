"""Checks for reference packing and capture-offset comparisons (no hardware)."""
import random
import unittest

from compare_reference import compare_pages, shift_reference
from photo_reference import pack_pages, read_pgm, sample_grid


class ReferenceTests(unittest.TestCase):
    def test_pgm_binary_whitespace_and_comment(self):
        self.assertEqual(read_pgm(b'P5\n# grid\n2 2\n255\n\n\r #'),
                         (2, 2, b'\n\r #'))
        self.assertEqual(read_pgm(b'P5\r\n1 1\r\n255\r\n\n'), (1, 1, b'\n'))
        with self.assertRaises(ValueError):
            read_pgm(b'P5\n2 2\n255\n\x00')

    def test_column_packing_page_boundary(self):
        rows = [[0] * 128 for _ in range(64)]
        for x, y in ((0, 0), (0, 7), (127, 7), (0, 8), (127, 63)):
            rows[y][x] = 1
        result = pack_pages(rows)
        self.assertEqual(len(result), 1024)
        self.assertEqual((result[0], result[127], result[128], result[-1]), (129, 128, 1, 128))
        self.assertEqual(sum(v.bit_count() for v in result), 5)

    def test_sampling_and_mask(self):
        rows, masks = sample_grid((3, 2, bytes([0, 130, 255, 255, 129, 0])),
                                  (3, 2), (0, 0), (1, 1), 0, 130, 0, 30)
        self.assertEqual(rows, [[0, 1, 1], [1, 0, 0]])
        self.assertEqual(masks, [[1, 0, 1], [1, 0, 1]])
        with self.assertRaises(ValueError):
            sample_grid((1, 1, b'\0'), (2, 1), (0, 0), (1, 1), 0, 130, 0, 30)

    def test_shift_carries_across_pages_and_masks_new_pixels(self):
        reference = bytearray(1024)
        reference[4] = 128
        shifted, mask = shift_reference(reference, b'\xff' * 1024, 2, 1)
        self.assertEqual(shifted[128 + 6], 1)
        self.assertEqual(sum(v.bit_count() for v in shifted), 1)
        self.assertEqual(mask[0], 0)
        self.assertEqual(mask[2], 254)

    def test_capture_offsets_with_commands_and_command_like_pixels(self):
        rng = random.Random(27)
        frame = bytearray(rng.randbytes(1024))
        capture = bytearray(b'\xde\xad\xbe\xef')
        offsets = []
        for page in range(8):
            capture.extend((0xb0 + page, 0, 0x10))
            offsets.append(len(capture))
            frame[page * 128:page * 128 + 4] = bytes((0, 0x10, 0xb0 + page, 0))
            capture.extend(frame[page * 128:(page + 1) * 128])
        reports = compare_pages(capture, frame, b'\xff' * 1024, 1)
        for page, report in enumerate(reports):
            best = report['candidates'][0]
            self.assertEqual(best['payload_offset'], offsets[page])
            self.assertEqual(best['bit_errors'], 0)

    def test_mask_ignores_uncertain_bits_and_blank_page_skips(self):
        rng = random.Random(1)
        reference = rng.randbytes(1024)
        mask = b'\xfe' * 1024
        noisy = bytes(v ^ 1 for v in reference)
        reports = compare_pages(b'\x99' * 7 + noisy, reference, mask, 1)
        self.assertEqual(reports[0]['candidates'][0]['payload_offset'], 7)
        self.assertEqual(reports[0]['candidates'][0]['bit_errors'], 0)
        self.assertIn('skipped', compare_pages(b'\x00' * 128, b'\x00' * 1024, b'\xff' * 1024)[0])


if __name__ == '__main__':
    unittest.main()
