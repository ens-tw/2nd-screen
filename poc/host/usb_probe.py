#!/usr/bin/env python3
# USB 探針：找出 Feather RP2040，回報它現在的狀態，並可讀出韌體吐出的內容。
# ---------------------------------------------------------------------------
# 用途：bench bring-up 與接目標評估板時，一句話問清楚板子在哪個狀態，不必再
#       手動翻 ioreg / ls /Volumes。只讀不寫；純標準函式庫，不需要 pyserial 或 venv。
#
# 三種狀態：
#   BOOTSEL  — /Volumes/RPI-RP2 已掛載 → 可以燒錄（把 spi_tap.uf2 拖進去）。
#   RUNNING  — 板子以 USB CDC 列舉出序列埠 → 韌體在跑，可用 --read 讀它吐的位元組。
#   ABSENT   — USB 上找不到 RP2040 → 檢查線材（要能傳資料，不是只充電）、重插。
#
# 用法：
#   python3 usb_probe.py              # 回報狀態
#   python3 usb_probe.py --read 5     # 若 RUNNING，開序列埠讀 5 秒，原樣印出
#   python3 usb_probe.py --read       # 同上，預設讀 3 秒
#
# 平台：主力在 macOS（ioreg）；附帶 Linux 後援（/dev/ttyACM*、/sys 的 idVendor）。
import glob
import os
import select
import subprocess
import sys
import time

# RP2040 / Adafruit 相關的 USB vendor id（十進位）。
VID_RASPBERRY = 11914   # 0x2E8A，RP2 開機（BOOTSEL）與原生 pico-sdk 裝置
VID_ADAFRUIT = 9114     # 0x239A，Feather RP2040（含 DVI 版）
RP2040_VIDS = {VID_RASPBERRY, VID_ADAFRUIT}

# 同一台機器上常見但與本專案無關的序列裝置，排除以免誤判。
KNOWN_OTHER_VIDS = {
    12346,  # 0x303A Espressif ESP32（JTAG/serial debug unit）
}

BOOTSEL_VOLUME = "/Volumes/RPI-RP2"


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except (subprocess.SubprocessError, OSError):
        return ""


def find_bootsel():
    """回傳 BOOTSEL 掛載點，找不到回 None。"""
    if sys.platform == "darwin":
        return BOOTSEL_VOLUME if os.path.isdir(BOOTSEL_VOLUME) else None
    # Linux：以 label 找 RPI-RP2。
    for p in glob.glob("/dev/disk/by-label/RPI-RP2"):
        return os.path.realpath(p)
    return None


def _macos_rp2040_ports():
    """解析 ioreg，回傳 [(product_name, callout_dev), ...]，只留 RP2040 vendor。"""
    out = _run(["ioreg", "-rc", "IOUSBHostDevice", "-l"])
    ports = []
    name, vid = None, None
    for line in out.splitlines():
        s = line.strip().strip("| ")
        if '"USB Product Name"' in s:
            name = s.split("=", 1)[1].strip().strip('"')
        elif '"idVendor"' in s:
            try:
                vid = int(s.split("=", 1)[1].strip())
            except ValueError:
                vid = None
        elif "IOCalloutDevice" in s:
            dev = s.split("=", 1)[1].strip().strip('"')
            # callout 掛在裝置子節點，沿用最近一個裝置的 name/vid。
            if vid in RP2040_VIDS and dev.startswith("/dev/"):
                ports.append((name or "RP2040", vid, dev))
    return ports


def _linux_rp2040_ports():
    ports = []
    for dev in sorted(glob.glob("/dev/ttyACM*")):
        base = os.path.basename(dev)
        vid = None
        for vpath in glob.glob(f"/sys/class/tty/{base}/device/../../idVendor") + \
                glob.glob(f"/sys/class/tty/{base}/../idVendor"):
            try:
                with open(vpath) as f:
                    vid = int(f.read().strip(), 16)
                break
            except (OSError, ValueError):
                pass
        if vid in RP2040_VIDS:
            ports.append((f"RP2040 ({base})", vid, dev))
    return ports


def find_running_ports():
    """回傳確定屬於 RP2040 的序列埠清單 [(name, vid, dev), ...]。"""
    if sys.platform == "darwin":
        ports = _macos_rp2040_ports()
    elif sys.platform.startswith("linux"):
        ports = _linux_rp2040_ports()
    else:
        ports = []
    # 偏好 /dev/cu.*（macOS 撥出埠，開啟時不等 carrier）。
    norm = []
    for name, vid, dev in ports:
        if sys.platform == "darwin":
            dev = dev.replace("/dev/tty.", "/dev/cu.")
        norm.append((name, vid, dev))
    # 去重。
    seen, uniq = set(), []
    for item in norm:
        if item[2] not in seen:
            seen.add(item[2])
            uniq.append(item)
    return uniq


def read_port(dev, seconds):
    """開序列埠讀 seconds 秒，原樣印到 stdout。USB CDC 的 baud 會被忽略。"""
    try:
        fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
    except OSError as e:
        print(f"  無法開啟 {dev}：{e}")
        return
    print(f"  讀取 {dev}（{seconds:.0f}s）——")
    deadline = time.time() + seconds
    got = 0
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.3)
            if r:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if chunk:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                    got += len(chunk)
    finally:
        os.close(fd)
    if got == 0:
        print("\n  （期間沒有資料——韌體閒置中？CS 為高時沒有 SPI 活動就不會輸出。）")
    else:
        print(f"\n  （共 {got} bytes）")


def main():
    args = sys.argv[1:]
    if "--probe" in args:
        # 唯讀探針（供 ticket-board resource 用）：Feather 在（BOOTSEL 或 RUNNING）回 0，否則回 1。
        # 只查 USB/磁碟列舉，不開序列埠、不改任何狀態。
        return 0 if (find_bootsel() or find_running_ports()) else 1
    do_read = "--read" in args
    seconds = 3.0
    if do_read:
        i = args.index("--read")
        if i + 1 < len(args):
            try:
                seconds = float(args[i + 1])
            except ValueError:
                pass

    bootsel = find_bootsel()
    if bootsel:
        print(f"狀態：BOOTSEL — 已掛載於 {bootsel}")
        print("  可燒錄：把 poc/build/spi-tap/spi_tap.uf2 複製進去，板子會自動重開進韌體。")
        return 0

    ports = find_running_ports()
    if ports:
        print(f"狀態：RUNNING — 找到 {len(ports)} 個 RP2040 序列埠：")
        for name, vid, dev in ports:
            print(f"  {dev}   [{name}, vid=0x{vid:04x}]")
        if do_read:
            read_port(ports[0][2], seconds)
        else:
            print("  用 `--read [秒數]` 讀出韌體輸出（啟動時會印 banner；有 SPI 活動才會有 hex）。")
        return 0

    print("狀態：ABSENT — USB 上找不到 RP2040。")
    print("  BOOTSEL 燒錄：按住 BOOTSEL、點一下 RESET（或按住 BOOTSEL 再插 USB）→ 應出現 RPI-RP2。")
    print("  若接上仍 ABSENT：換一條能傳『資料』的 USB 線（很多線只供電），或換個埠／移除 USB hub。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
