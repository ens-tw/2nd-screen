// Ticket board configuration. Format and options: the ticket-board skill, references/board-format.md.
import type { Config } from './engine/types.mts';
import { probes } from './engine/lib.mts';

export default {
  ids: /^P-\d+$/,
  main: 'main',
  tests: 'ctest',                      // 若日後加 test doneWhen，對應 poc 的 CMake/CTest
  boxes: ['mac'],                      // 目前只有這台開發機接硬體
  groups: {
    P: 'PoC — 螢幕匯流排旁觀重現與 demo',
  },
  resources: {
    // Feather RP2040（本機 USB）。接著時可燒錄/擷取；拔掉時 next 會提示重接。
    // 探針唯讀：usb_probe.py --probe，在（BOOTSEL 或 RUNNING）回 0。
    feather: {
      on: 'mac',
      paths: ['poc/rp2040-spi-tap/'],
      policy: '一個 process 佔用序列埠；燒錄用 picotool（先 reboot -f -u 進 BOOTSEL）',
      bringUp: '把 Feather RP2040 接回本機 USB（要能傳資料的線）；確認 usb_probe.py 回報 RUNNING/BOOTSEL',
      probe: probes.cmd(['python3', 'poc/host/usb_probe.py', '--probe'], { hosted: true, timeoutMs: 8000 }),
    },
  },
} satisfies Config;
