// 工作佇列。狀態與欄位規則見 ticket-board skill 的 references/board-format.md。
// 讀板子一律用 CLI（node tickets/engine/cli.mjs next|list|show），不要直接 grep 這個檔。
//
// 本 repo = 2nd-screen：被動把點陣顯示匯流排鏡到第二螢幕。核心主張已於真機達成：
//   被動搭四線 → live_mirror.py 即時 ASCII 鏡像評估板畫面（P-1~P-5 done）。
//   剩 P-6/P-7 為 demo 排練與實演（owner 動手）。
import type { Board } from './engine/types.mts';

export default [
  // ── P：被動擷取 → 第二螢幕 重現與 demo ─────────────────────────────
  {
    id: 'P-1',
    title: '擷取鏈自測：RP2040 on-chip loopback',
    why: '用晶片自身產生的已知 SPI 樣式確認 PIO 取樣/DMA/USB 位元組鏈正確，接目標板前先排除韌體 bug。免跳線、免動手。',
    refs: ['poc/rp2040-spi-tap/loopback_test.c', 'poc/rp2040-spi-tap/spi_tap.c', 'poc/rp2040-spi-tap/spi_tap.pio'],
    group: 'P',
    status: 'done',
    commit: '216d935',
    doneWhen: { kind: 'answer', doc: 'docs/2nd-screen.md' },
  },
  {
    id: 'P-2',
    title: '評估板：前置量測與被動擷取 控制器→OLED',
    why: '在自有點陣顯示評估板量測顯示匯流排電壓/時脈，接四條被動探針擷取畫面位元組。',
    refs: ['docs/2nd-screen.md', 'poc/rp2040-spi-tap/README.md'],
    group: 'P',
    status: 'done',
    commit: '43b128d',
    doneWhen: { kind: 'answer', doc: 'docs/2nd-screen.md' },
  },
  {
    id: 'P-4',
    title: '以真擷取驗證重建（即時第二螢幕）',
    why: '用真裝置資料證明重建成立。真擷取經 raster.py/live_mirror.py 重建出肉眼可讀的畫面字形，即時第二螢幕直接證實核心主張：被動搭四線即可旁觀顯示內容。',
    refs: ['docs/2nd-screen.md', 'poc/host/live_mirror.py', 'poc/host/raster.py'],
    group: 'P',
    status: 'done',
    commit: '2d90a6c',
    doneWhen: { kind: 'answer', doc: 'docs/2nd-screen.md' },
  },
  {
    id: 'P-5',
    title: 'demo run-of-show（第二螢幕）',
    why: '把重現包裝成給團隊的 10 分鐘 demo：定場→搭線→即時第二螢幕（高潮，現場跑 live_mirror.py）→轉折→防護收尾。',
    refs: ['docs/2nd-screen.md'],
    group: 'P',
    status: 'done',
    commit: '8b57e75',
    doneWhen: { kind: 'answer', doc: 'docs/2nd-screen.md' },
  },
  {
    id: 'P-6',
    title: '預錄擷取/搭線片段並排練（含 fallback）',
    why: '硬體現場 demo 易出包：預錄實體搭線，現場跑決定性的即時第二螢幕；完整排練一次並備妥 fallback。',
    refs: ['docs/2nd-screen.md', 'poc/rp2040-spi-tap/README.md'],
    group: 'P',
    status: 'blocked',
    after: ['P-4', 'P-5'],
    next: 'owner 錄下搭線＋即時第二螢幕（live_mirror.py）片段，依 P-5 的 run of show 完整排練一次；現場以 live_mirror 為決定性橋段，確認 fallback（預錄片段）就緒。',
    blockers: [
      { kind: 'owner', ask: '錄製實體搭線/即時第二螢幕片段並排練——需動手操作評估板', since: '2026-10-31' },
    ],
    doneWhen: { kind: 'judgment', when: '依 run of show 完整排練過一次，預錄片段與現場第二螢幕都可用，fallback 就緒' },
  },
  {
    id: 'P-7',
    title: '對團隊實演 demo',
    why: 'demo 的終點：在團隊面前跑完全程，收尾帶出顯示路徑的防護方向與下一步。',
    refs: ['docs/2nd-screen.md'],
    group: 'P',
    status: 'blocked',
    after: ['P-6'],
    next: '向團隊實演，收尾帶出防護方向（顯示介面納入安全邊界／顯示鏈加密/MAC／走線物理防護與開殼偵測）與下一步，記下決議。',
    blockers: [
      { kind: 'owner', ask: '安排並主持對團隊的實演場次', since: '2026-10-31' },
    ],
    doneWhen: { kind: 'judgment', when: 'demo 在團隊面前完整跑過一次，並帶出防護方向與下一步決議' },
  },
] satisfies Board;
