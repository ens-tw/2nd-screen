/* 現場切換配色：教室燈光無法事先測，所以講者要能當場換。
   c ／ Shift+C  下一個／上一個固定主題（tokens.css 的 --deck-themes，依序循環）
   g ／ Shift+G  產生一組種子隨機配色／回到上一組隨機配色（記住最近 10 組）
   網址 #theme=paper 或 #theme=r4821 直接載入該主題或種子；可與 #debug 並用（#debug&theme=r4821）。
   起始主題：網址 #theme= ＞ 觀眾上次的選擇 ＞ 本份簡報的預設（<html data-deck-theme-default="projector-light">，
   可填主題 id 或種子 r4821）＞ --deck-themes 的第一個。預設寫在 deck.html，讓每份簡報依場地選起始主題而不必改 tokens.css。
   選擇依每份簡報記住，並與講者視窗及縮圖同步（同字級控制）；存的是主題 id 或種子，不存顏色。
   隨機配色由 deck-palette.js 依 deck-theme-rules.js 產生並驗證，載入順序：rules → palette → 本檔。
   必須在 deck-stage.js 之前載入，因為 deck-stage 一啟動就把網址的 # 改成頁碼。 */
(() => {
  const root = document.documentElement;
  const storageKey = `deck-theme:${location.pathname}`;
  const historyKey = `deck-theme-history:${location.pathname}`;
  const thumbnail = new URLSearchParams(location.search).has('_snthumb');
  const debug = /(^#|&)debug(&|$)/.test(location.hash);
  const rules = window.deckThemeRules, palette = window.deckPalette;
  const tokenNames = rules ? ['theme-name', ...rules.tokens, 'shadow-lg'] : [];
  const themes = getComputedStyle(root).getPropertyValue('--deck-themes').trim().split(/\s+/).filter(Boolean);
  const isTheme = (v) => themes.includes(v) || /^r\d+$/.test(v || '');
  // 本份簡報的預設；寫錯的 id 退回主題 1 並在主控台提醒，免得以為設定生效。
  const declared = root.dataset.deckThemeDefault || '';
  if (declared && !isTheme(declared)) console.warn(`[deck-theme] data-deck-theme-default="${declared}" 不在 --deck-themes，也不是種子 r<數字>；改用主題 1`);
  const fixedDefault = themes.includes(declared) ? declared : themes[0] || '';
  const startTheme = isTheme(declared) ? declared : fixedDefault;
  let current = themes[0] || '', lastFixed = 0, timer;

  const status = document.createElement('output');
  status.className = 'deck-font-status deck-theme-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  if (!thumbnail) document.body.append(status);

  function toast(text) {
    if (thumbnail) return;
    status.textContent = text;
    status.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { status.hidden = true; }, 2200);
  }
  const store = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 無法儲存時只影響本視窗 */ } };
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const history = () => { try { return JSON.parse(read(historyKey)) || []; } catch { return []; } };

  // 種子配色以行內 style 蓋過 tokens.css；換回固定主題前先清掉，免得殘留。
  function clearInline() { for (const k of tokenNames) root.style.removeProperty('--' + k); }

  function apply(value, announce = false) {
    if (!isTheme(value)) value = startTheme;      // 沒存過、存的主題已不存在、或 storage 被清空
    const seed = /^r(\d+)$/.exec(value);
    clearInline();
    if (seed && rules && palette) {
      const made = palette.generate(Number(seed[1]), rules);
      if (made) {
        for (const [k, v] of Object.entries(made.tokens)) root.style.setProperty('--' + k, v);
        root.dataset.deckTheme = current = value;
        if (debug) console.info('[deck-theme] 想留下這組配色：貼進 tokens.css、改 id 與 --theme-name、加進 --deck-themes\n'
                                + palette.css(value, made.tokens, rules));
        if (announce) toast(`隨機 #${seed[1]}`);
        return;
      }
    }
    // 種子產生失敗（或缺配色兩檔）時退回預設的固定主題。主題 1 就是 :root 本身，所以清掉屬性，
    // 而存下的是它的 id，不是空字串，下次開啟才不會被預設蓋過。
    const index = Math.max(0, themes.indexOf(themes.includes(value) ? value : fixedDefault));
    if (index) root.dataset.deckTheme = themes[index]; else delete root.dataset.deckTheme;
    current = themes[index] || '';
    lastFixed = index;
    if (announce) {
      const name = getComputedStyle(root).getPropertyValue('--theme-name').trim().replace(/^["']|["']$/g, '');
      toast(themes.length ? `主題 ${index + 1}/${themes.length}・${name}` : 'tokens.css 沒有主題清單（--deck-themes）');
    }
  }

  function choose(value) {
    apply(value, true);
    store(storageKey, current);
  }

  function step(direction) {
    if (!themes.length) { toast('tokens.css 沒有主題清單（--deck-themes）'); return; }
    const from = themes.includes(current) ? themes.indexOf(current) : lastFixed;   // 從隨機配色接回上次的固定主題
    choose(themes[(from + direction + themes.length) % themes.length]);
  }

  function generate() {
    if (!rules || !palette) { toast('缺 deck-theme-rules.js 或 deck-palette.js，無法產生隨機配色'); return; }
    for (let tries = 0; tries < 5; tries++) {
      const seed = 1 + Math.floor(Math.random() * 9999);
      if (palette.generate(seed, rules)) {
        const list = history().filter(s => s !== seed).concat(seed).slice(-10);
        store(historyKey, JSON.stringify(list));
        choose(`r${seed}`);
        return;
      }
    }
    toast('這次沒有產生出合格配色，請再按一次 g');
  }

  function back() {
    const list = history();
    if (/^r\d+$/.test(current) && list[list.length - 1] === Number(current.slice(1))) list.pop();
    if (!list.length) { toast('沒有上一組隨機配色'); return; }
    store(historyKey, JSON.stringify(list));
    choose(`r${list[list.length - 1]}`);
  }

  function handle(key, shift) {
    if (key === 'c') step(shift ? -1 : 1);
    else if (key === 'g') (shift ? back : generate)();
    else return false;
    return true;
  }

  const fromHash = /(?:^#|&)theme=([\w-]+)/.exec(location.hash);
  if (fromHash) choose(fromHash[1]);
  else apply(read(storageKey));

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.composedPath().some(t => t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (handle(event.key.toLowerCase(), event.shiftKey)) event.preventDefault();
  });

  // 講者視窗轉送的按鍵：大寫代表按著 Shift。
  window.addEventListener('message', (event) => {
    const key = event.data?.deckThemeKey;
    if (typeof key === 'string' && key.length === 1) handle(key.toLowerCase(), key !== key.toLowerCase());
  });

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) apply(event.newValue);
  });
})();
