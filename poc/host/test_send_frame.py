"""Exercise one-shot writes over a real pseudo-terminal, without hardware."""
import contextlib
import io
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import threading
import time
import tty
import unittest
from unittest.mock import patch
import zlib

import send_frame


class SendFrameTests(unittest.TestCase):
    frame = bytes(range(256)) * 4

    def exchange(self, hello=send_frame.HELLO, acknowledge=True, error=False):
        master, slave = pty.openpty()
        tty.setraw(slave)
        requests, failures = [], []

        def line():
            buf = bytearray()
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    ch = os.read(master, 1)
                    if ch == b'\n':
                        return bytes(buf)
                    buf.extend(ch)
            raise TimeoutError('emulator did not receive a complete line')

        def device():
            try:
                requests.append(line())
                os.write(master, hello + b'\r\n')
                if hello != send_frame.HELLO:
                    time.sleep(0.1)
                    if select.select([master], [], [], 0)[0]:
                        failures.append('frame sent to incorrect firmware')
                    return
                requests.append(line())
                if acknowledge:
                    reply = (b'ERR invalid-frame no-write' if error else
                             f'DONE 1024 {zlib.crc32(self.frame):08x} HIGH_Z'.encode())
                    os.write(master, reply + b'\r\n')
                else:
                    # The client must not repeat the request after losing ACK.
                    if select.select([master], [], [], 0.4)[0]:
                        failures.append('automatic retry detected')
            except Exception as exc:
                failures.append(str(exc))

        worker = threading.Thread(target=device, daemon=True)
        worker.start()
        try:
            original_read = send_frame.read_line
            def quick_read(fd, timeout=3):
                return original_read(fd, timeout=min(timeout, 0.3) if not acknowledge else timeout)
            with patch.object(send_frame, 'read_line', side_effect=quick_read):
                if hello != send_frame.HELLO:
                    with self.assertRaisesRegex(ValueError, 'no frame sent'):
                        send_frame.send_frame(os.ttyname(slave), self.frame)
                elif not acknowledge or error:
                    with self.assertRaisesRegex(RuntimeError, 'No retry was sent'):
                        send_frame.send_frame(os.ttyname(slave), self.frame)
                else:
                    result = send_frame.send_frame(os.ttyname(slave), self.frame)
                    self.assertEqual(result, f'DONE 1024 {zlib.crc32(self.frame):08x} HIGH_Z')
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])
        finally:
            os.close(slave)
            os.close(master)
        self.assertEqual(requests[0], b'HELLO')
        if hello == send_frame.HELLO:
            self.assertEqual(len(requests), 2)
            tag, crc, payload = requests[1].split()
            self.assertEqual(tag, b'WRITE1')
            self.assertEqual(int(crc, 16), zlib.crc32(self.frame))
            self.assertEqual(bytes.fromhex(payload.decode()), self.frame)
        else:
            self.assertEqual(len(requests), 1)

    def test_exact_payload_and_matching_ack(self):
        self.exchange()

    def test_wrong_firmware_gets_no_frame(self):
        self.exchange(hello=b'SPI Tap Stream v2')

    def test_lost_ack_is_not_retried(self):
        self.exchange(acknowledge=False)

    def test_device_rejection_is_not_retried(self):
        self.exchange(error=True)

    def test_invalid_frame_opens_no_device(self):
        with patch.object(send_frame.os, 'open') as opened:
            with self.assertRaisesRegex(ValueError, '1024'):
                send_frame.send_frame('/dev/not-a-device', b'bad')
            opened.assert_not_called()

    def test_dry_run_opens_no_device(self):
        with tempfile.TemporaryDirectory() as temp:
            frame = Path(temp) / 'frame.bin'
            frame.write_bytes(self.frame)
            with patch('sys.argv', ['send_frame.py', str(frame), '--dry-run']), \
                    patch.object(send_frame, 'send_frame') as sender, \
                    patch.object(send_frame, 'find_running_ports') as discover, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(send_frame.main(), 0)
                sender.assert_not_called()
                discover.assert_not_called()

    @unittest.skipUnless(shutil.which('cc'), 'native C compiler required')
    def test_firmware_accepts_exact_frame_and_rejects_corruption(self):
        source = r'''
#include <stdio.h>
#include "display_write_protocol.h"
int main(void) {
    char line[DISPLAY_WRITE_LINE_BYTES + 2];
    uint8_t frame[DISPLAY_FRAME_BYTES];
    uint32_t crc;
    size_t length = fread(line, 1, sizeof(line), stdin);
    if (!display_parse_write(line, length, frame, &crc)) return 2;
    return fwrite(frame, 1, sizeof(frame), stdout) == sizeof(frame) ? 0 : 1;
}
'''
        include = Path(__file__).resolve().parents[1] / 'rp2040-spi-tap'
        request = f'WRITE1 {zlib.crc32(self.frame):08x} {self.frame.hex()}'.encode()
        invalid = [request[:-1], request + b'0', b'HELLO',
                   request[:7] + b'00000000' + request[15:],
                   request[:16] + b'gg' + request[18:],
                   request[:16] + b'01' + request[18:]]
        with tempfile.TemporaryDirectory() as directory:
            cfile, exe = Path(directory) / 'parser.c', Path(directory) / 'parser'
            cfile.write_text(source)
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-I', str(include), str(cfile), '-o', str(exe)],
                           check=True, capture_output=True)
            result = subprocess.run([str(exe)], input=request, capture_output=True, check=True)
            self.assertEqual(result.stdout, self.frame)
            for bad in invalid:
                with self.subTest(request=bad[:20], length=len(bad)):
                    result = subprocess.run([str(exe)], input=bad, capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
