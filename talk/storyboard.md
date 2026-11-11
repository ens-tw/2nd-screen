# 分鏡稿

<!-- 一張投影片一列。每列指回 points.md 的 P 編號；事實只在 Model（draft.qmd）。
     前提只用條列（build 把表格列當投影片數）。寫法見 deck-plan；版型見 layout-catalog.md。
     照片／影片頁用 L-CANVAS 的 svg: art/*.svg（由 tools/make_art.py 產生：python3 tools/make_art.py .；改圖就改腳本重產）。
     這些 SVG 內部自己標 data-beat，所以該列動態填 M-NONE，避免外層再包一拍。 -->

## 前提

- 標題：主標「第二螢幕」；副標「重現 Ledger 硬體植入研究、用 AI 無碼打造被動顯示探針，與 CoolWallet 的 AI 防禦」。不把未確認的指控寫成事實——「植入」只描述已由 Ledger 證實者，估損數字一律附出處與「估計」。
- 聽眾：CoolWallet（庫幣）內部團隊，硬體／韌體／安全素養中上；此刻正在導入「AI 賦能防禦」。要帶走的是「AI 怎麼改變攻防成本，以及我們該先守哪一層」。
- 時間：約 25 分鐘＋問答；重心在第三、四段（AI 協作與防禦意涵）。時間不足時先跳零件頁與時間線，不跳置換對照與結論。
- 場地與投影：內部會議室投影；深色主題；字級下限 34px。
- 風格：熱鬧——照片、影片全上；活潑模式開啟，段落破題用逐字彈入，照片逐張彈出，對照表逐列出現。
- 用語：技術名詞保留英文（SPI、OLED、Secure Element、PIO、DMA、eSIM、SSD1306、RLE、bit-slip）；Joe Grand 保留原名；助記詞＝recovery phrase。
- 目標框定：明講示範裝置是一支自有的 Ledger Nano X；手法通用於任何「控制器→OLED 明文 SPI」；repo 文件把目標通稱為「點陣顯示評估板」。
- 關鍵數字：$86M+
- 流程步驟：S1 協定分析、S2 解碼器、S3 編碼器、S4 接線（對應置換對照四環節）。

## 待選

## 投影片

| # | 來源論點 | 內容形狀 | 版型 | 動態 | 講 | 畫面內容 | 口說重點 | 名詞與提問 | AI 協助 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 0 | — | 14 封面 | L-HERO-TITLE | M-CHARS | 0.5 min | title: 第二螢幕<br>sub: 重現 Ledger 硬體植入研究、用 AI 無碼打造被動顯示探針，與 CoolWallet 的 AI 防禦<br>meta: JZ · CoolWallet 內部分享 · 2026-11-11 | 開場一句：今天用一條真實攻擊鏈，談 AI 怎麼改變硬體攻防的成本 | — | 本頁文字由作者定稿 |
| 1 | P1 | 11 Numbers | L-STAT-HERO | M-SCRAMBLE | 2 min | eyebrow: 新聞<br>title: 2026 年 10 月，Ledger 出事了<br>stat_number: $86M+<br>stat_label: CryptoBilis 通路植入事件的估計遭竊金額（Specter 估計；Ledger 未公布總額）<br>context: Ledger 2026-10-10 證實裝置含未授權硬體植入；共同向量為東南亞經銷商 CryptoBilis<br>implications:<br>- 不是軟體漏洞: 是出廠前就被動過手腳的實體裝置<br>- 不是單一個案: 多國通路、多機型回報 | 定場；其他估計 $93M–$103M、Tether 凍結約 $10M。數字只是鉤子，真正的問題是它怎麼辦到的 | Secure Element、Q1 | 數字與出處由 AI 彙整公開報導、我逐條核對 |
| 2 | P1 | 11 Evidence collage | L-CANVAS | M-NONE | 1.5 min | eyebrow: 新聞<br>title: 不是單一個案：多國、多機型<br>svg: art/news-collage.svg<br>caption: 照片：Karpelès Lab／Tibane OSINT 追蹤器彙整的公開貼文<br>verdict: 德國、日本、新加坡、俄羅斯、東南亞經銷商——Nano X、Flex、Stax 都有 | 一按，六張照片依序彈出；點出 MediaMarkt 店內貨架那張：「店裡買的也中」 | OSINT、Q2 | AI 協助從追蹤器挑照片與對應地點、我核對來源 |
| 3 | P2 | 1 One claim | L-SPLIT-ANCHOR | M-STEP | 1.5 min | eyebrow: 新聞<br>title: 最反直覺的一點<br>anchor: 真機、真安全元件、Genuine Check 全過——因為植入加在它們「之外」<br>items:<br>- 安全元件沒被破: 植入不改 SE、不改 OS、不改簽章<br>- 官方自檢過關: Ledger 也說 Genuine Check 偵測不到加裝的植入<br>- 所以難防: 使用者沒有訊號知道「這支被動過」<br>footer_cite: Ledger / BleepingComputer, 2026-10 | 這一點決定了後面所有防禦的方向：不能只信「元件是真的」 | Genuine Check、Secure Element、Q1 | AI 整理官方說法、我核對原文 |
| 4 | P1 | 9 Timeline | L-TIMELINE-RAIL | M-STEP | 1.5 min | eyebrow: 新聞<br>title: 從研究到爆發<br>events:<br>- [2025-08] Reddit 警告: 有人在賣會偷幣的 Nano X<br>- [2026-05] Grand 公開研究: Hardwear.io USA 逆向植入<br>- [2026-09-16] 連起來: Karpelès 指新批次與 Grand 同源<br>- [2026-10-10] Ledger 證實: 要 CryptoBilis 停售<br>- [2026-10-13] 擴大下架: 東南亞經銷商、MediaMarkt 停售<br>takeaway: 一份研究公開後數月，變成跨國零售事件 | 研究→被發現→擴大的節奏；Grand 2026-03 已通報 Ledger | Q2 | AI 由 OSINT 追蹤器與報導建時間線、我核對日期 |
| 5 | — | 14 段落破題 | L-HERO-TITLE | M-CHARS | 0.2 min | title: 一、研究<br>sub: Joe Grand 怎麼逆向這個植入 | 轉到研究段 | — | — |
| 6 | P3 | 1 One claim | L-SPLIT-ANCHOR | M-STEP | 2 min | eyebrow: 一、研究<br>title: 攻擊的要害在哪<br>anchor: 不破解安全元件，而是旁聽「控制器→螢幕」那條明文 SPI<br>items:<br>- 螢幕是明文: 助記詞設定時就顯示在 OLED 上<br>- 顯示線可及: 裝置內部碰得到那條 SPI<br>- 於是: 被動聽就能把畫面讀出來<br>footer_cite: Grand, Hardwear.io USA 2026, p.36／p.77 | 這就是我復刻時鎖定的那一段——記住「明文顯示鏈」 | SPI、OLED、Q3 | — |
| 7 | P4 | 8 Process (photos) | L-CANVAS | M-NONE | 2.5 min | eyebrow: 一、研究<br>title: 植入三要素（SP1／SP2／SP3）<br>svg: art/sp-triptych.svg<br>caption: 照片：Joe Grand, Hardwear.io USA 2026 投影片<br>verdict: 植入吃掉裝置內部的物理餘裕，從外觀看不出來 | 一按一張：縮電池騰空間→塞進腔體搭 OLED SPI→獨立小板接主板 | Li-Po、Q3 | AI 協助判讀照片上的零件標記、我核對投影片 |
| 8 | P4 | 8 Parts (photo) | L-CANVAS | M-NONE | 1.5 min | eyebrow: 一、研究<br>title: 拆開看：一塊小板、四個零件<br>svg: art/parts.svg<br>caption: Joe Grand 投影片 p.66（零件標註為原作者所加）<br>verdict: MCU 讀螢幕、4G 模組加 eSIM 負責外送 | 逐項點：MCU、4G、eSIM（荷蘭 Vodafone 漫遊資料卡）、手繞天線 | MCU、eSIM、Q3 | — |
| 9 | P5 | 8 Causal chain | L-FLOW-3STAGE | M-POP | 2 min | eyebrow: 一、研究<br>title: 韌體怎麼把螢幕變成助記詞<br>stages:<br>- 監看 SPI: 旁聽 Secure Element↔OLED 的匯流排<br>- 樣板比對: 用 flash 內 a–z 字形比對畫面字母<br>- 外送: 湊出助記詞存 flash，經 4G LTE 送出<br>verdict: 外洩的是「螢幕上顯示的明文」，不是破解出來的密鑰 | 完整資料流；下一段我只復刻第一棒 | 字形樣板（glyph template）、Q3 | AI 協助讀 flash 位址與反編譯片段、我對照投影片 |
| 10 | — | 14 段落破題 | L-HERO-TITLE | M-CHARS | 0.2 min | title: 二、復刻<br>sub: jz 版：被動顯示探針 | 轉到復刻段 | — | — |
| 11 | P6/P8 | 6 Two-sided contrast | L-VS-CONFRONT | M-STEP | 2.5 min | eyebrow: 二、復刻<br>title: 我復刻什麼、刻意不做什麼<br>issue: 要證明「我懂這條攻擊線」，但不做一個真的武器<br>side_a: {camp: "研究者植入", points: ["主動植入在裝置內", "4G 外洩助記詞", "鎖定錢包備份"]}<br>side_b: {camp: "jz 第二螢幕", points: ["被動高阻抗、只讀", "不接 MISO、不接 +5V", "主動回寫路線已刻意移除"]}<br>ask_or_verdict: 只取最要害那一段：被動旁聽顯示線，把螢幕讀出來 | 倫理骨架；主動回寫路線 2026-11-02 移除 | 高阻抗、MISO、Q4 | — |
| 12 | P6 | 8 Process (photos) | L-CANVAS | M-NONE | 2 min | eyebrow: 二、復刻<br>title: 四條線，被動搭上一支 Nano X<br>svg: art/wiring.svg<br>verdict: GPIO 全程輸入、硬體鎖成永不驅動；手法適用任何「控制器→OLED 明文 SPI」 | 明講示範裝置是自有的 Nano X；repo 文件通稱「點陣顯示評估板」。資料路徑：四線→PIO 擷取→USB→主機鏡像 | PIO、DMA、Q4 | 接線由 AI 導引（避 Feather 絲印坑、選相鄰數位腳）、我電表復驗 |
| 13 | P7 | 11 Numbers | L-3CARD-VERDICT | M-POP | 2 min | eyebrow: 二、復刻<br>title: 真板證據：它真的讀得到<br>cards:<br>- [靜態] 0 邊緣/秒: 不切畫面時匯流排閒置<br>- [切畫面] ≈8312 邊緣/重繪: 一次重繪 ≈ 一張 128×64 全畫面<br>- [擷取] 12,480 B: 重建出肉眼可讀的字形<br>verdict: 被動搭四線，就能即時旁觀顯示內容——真機證實 | 數字來自 bus_probe 與真板；DC 1.8V 是電表讀值，未確認訊號振幅 | write-on-change、Q4 | 量測韌體由 AI 起草、數據我在真板上跑出 |
| 14 | P8 | 1 One claim (video) | L-CANVAS | M-NONE | 2.5 min | eyebrow: 二、復刻<br>title: 第二螢幕<br>svg: art/demo.svg<br>caption: 錄影 2nd.MP4（24 秒）；現場可改跑 live_mirror.py<br>verdict: 在裝置上切畫面，終端裡的鏡像同步跟著變 | 影片進頁就循環播；要現場示範就切到終端。fallback：錄影→重播擷取檔 | 第二螢幕、framebuffer | 主機重建由 AI 起草、我驗收畫面一致 |
| 15 | — | 14 段落破題 | L-HERO-TITLE | M-CHARS | 0.2 min | title: 三、無碼與 AI 協作<br>sub: Joe 手工做的，我用 AI 換掉哪些 | 轉到本場重心 | — | — |
| 16 | P9 | 7 Multi-item comparison | L-CANVAS | M-NONE | 3 min | eyebrow: 三、AI 協作<br>title: 置換對照：Joe 手工 → jz 用 AI<br>lead: 四個環節：三個由 AI 起草、一個由 AI 導引<br>svg: art/mapping.svg<br>verdict: 每一列最右欄「真板驗收」都還是我做的 | 本場主軸；一按一列：協定分析、解碼器、編碼器、接線 | 協定分析、Q5 | 本頁即在講 AI 的分工 |
| 17 | P9 | 6 before→after (photo) | L-CANVAS | M-NONE | 2 min | eyebrow: 三、AI 協作<br>title: ① 協定分析（S1）<br>svg: art/protocol.svg<br>caption: 左圖：Joe Grand 投影片 p.41<br>verdict: AI 給假設，真板給證據 | Joe 盯波形手工判讀；我讓 AI 推命令表（D5／81／A6／C0／A0＋B0..B7），再用真機核對與設限 | SSD1306、Q5 | 協定判讀 AI 起草、我核對並標限制 |
| 18 | P10 | 15 假設 vs 實證 | L-HYPOTHESIS-TEST | M-STEP | 2.5 min | eyebrow: 三、AI 協作<br>title: ② 編碼器（S3）：bit-slip<br>hypothesis: {label: "AI 初版 PIO", head: "每個 CLK 邊緣取樣 DI，湊成 byte", logic: "看起來對，loopback 自測也過"}<br>finding: {label: "真板現象", head: "第 15 包起全部右移 1 bit，畫面停住", status: "舊 PIO 碰不到 CS 拉高，多一個 bit 就一直錯位"}<br>theoretical_puzzle: 改成每脈衝只取 8 bit 並清殘留：注入測試 193/193、未注入 578/578 包對齊 | 本場最重要的一張：bug 是量測抓出來的，不是生成 | bit-slip、PIO、Q6 | PIO 由 AI 起草、bit-slip 由我在真板量測除錯 |
| 19 | P9 | 6 before→after (photos) | L-CANVAS | M-NONE | 1.5 min | eyebrow: 三、AI 協作<br>title: ③ 解碼器（S2）：同一手法，相反用途<br>lead: AI 起草主機端重建，我肉眼對照驗收<br>svg: art/decoder.svg<br>caption: 左圖：Joe Grand 投影片 p.71；右圖：2nd.MP4 截圖<br>verdict: 解碼器從「裝置內竊取」挪到「主機端重建」 | 左邊攻擊者解出助記詞，右邊我解出整張畫面 | decoder、framebuffer、Q5 | 重建解碼 AI 起草、我驗收並標限制 |
| 20 | — | 14 段落破題 | L-HERO-TITLE | M-CHARS | 0.2 min | title: 四、結論<br>sub: AI 時代的攻防，與 CoolWallet 的防線 | 轉到結論 | — | — |
| 21 | P11 | 1 One claim | L-BENTO-FOCUS | M-POP | 2 min | eyebrow: 四、結論<br>title: 復刻成本，對稱地崩塌了<br>hero_card: {tag: "核心主張", head: "世界級數週 → 一人 AI 數天", body: "同一股力量同時降低攻擊者造植入、和防禦者做驗證的成本。本專案就是一個人用 AI 幾天復刻核心手法的例子。"}<br>sub_cards:<br>- [仍然稀缺] 物理可及: AI 不會幫攻擊者拿到你手上的裝置<br>- [仍然稀缺] 可驗證性: 也不會自動證明你這支沒被動過<br>verdict: 不對稱移到了供應鏈完整性與可驗證性 | 把全場收束成一句對稱性 | — | — |
| 22 | P12 | 10 Levels | L-CASCADE-FUNNEL | M-STEP | 2.5 min | eyebrow: 四、結論<br>title: CoolWallet 該先守哪一層<br>levels:<br>- 顯示鏈加密 / MAC: 被動擷取只拿到密文，直接擋住這類攻擊<br>- 走線納入安全邊界: 控制器直驅、走線不可及、無測試點<br>- 物理防護＋開殼偵測: 灌膠、防拆網、外殼與主板配對<br>core_focus: 這三層的檢查都能從人工變成 AI 可規模化驗證——AI 賦能防禦的著力點 | 落到產品；把防禦與 AI 協作接起來 | MAC、開殼偵測、Q7 | — |
| 23 | P11/P12 | 2 Section close | L-FINALE-SUMMARY | M-STEP | 1.5 min | eyebrow: 四、結論<br>heading: 結語<br>onesentence: AI 時代仍然可信的，不是「AI 做的所以對」，而是事實分級＋真板驗收＋保留不臆測的紀律。<br>points_align: left<br>points:<br>- 攻防復刻成本對稱崩塌，稀缺的是物理可及與可驗證性<br>- 顯示鏈明文可及就守不住：加密/MAC、納入邊界、開殼偵測<br>- 討論：CoolWallet 要先投資哪一層？ | 收束＋拋討論題 | Q7 | — |
