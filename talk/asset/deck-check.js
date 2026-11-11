/* deck.html#debug 自我檢查：字級下限、是否溢出投影片框、文字與背景的對比。
   只在網址含 #debug 時啟用（可寫 #debug&theme=r4821），平常開啟與上台時不做任何事。
   必須在 deck-stage.js 之前載入，因為 deck-stage 一啟動就把網址的 # 改成頁碼。

   每到一頁、等進場動畫跑完後檢查該頁，結果寫在 document.body.dataset：
     minfont      ok ＝ 已檢查各頁的可見文字都 ≥ FLOOR（1920×1080 設計像素）；否則 small
     minfontBad   不合格處，例如「3 p.lead 30px; 5 td 28px」（頁碼與網址 #N 相同）
     overflow     none ＝ 沒有東西超出投影片框或被容器裁掉；否則 found
     overflowBad  超出處，例如「4 .content +62px; 6 .card 被裁 18px」
     contrast     ok ＝ 可見文字對實際背景都 ≥ label 門檻（deck-theme-rules.js，4.5:1）；否則 low
     contrastBad  不合格處，例如「5 td.dim 3.9:1」
     contrastNote 內文字級（標稱 38–42px）卻 < body 門檻（7:1）者，提醒但不算不合格
     contrastUnknown 背景是圖片、或顏色格式無法換算，無法判斷者（不猜）
     checked      已檢查的頁碼
   背景的找法：從文字往外找第一層不透明的背景色，途中半透明的顏色與漸層逐層疊上；漸層取各色標
   與中點、取最差者，所以是保守估計。SVG 文字另以 elementsFromPoint 找壓在底下的圖形。
   同樣的內容也會以 console.warn 輸出。調整 +／− 字級或換主題（c／g）後先前結果作廢，重新檢查目前這頁。 */
(() => {
  if (!/(^#|&)debug(&|$)/.test(location.hash)) return;

  const FLOOR = 34;                        // 表格與標籤的下限；內文預設 40
  const EXEMPT = '.hero__hint';            // 講者用的按鍵提示，觀眾不需要讀
  const results = new Map();               // 頁碼 → { small: [], overflow: [] }

  function describe(el) {
    const cls = [...el.classList].slice(0, 2).map(c => '.' + c).join('');
    return el.tagName.toLowerCase() + cls;
  }

  function textNodes(slide) {
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!node.textContent.trim() || !el) return NodeFilter.FILTER_REJECT;
        if (el.closest('[aria-hidden="true"], script, style, ' + EXEMPT)) return NodeFilter.FILTER_REJECT;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  // ---------- contrast ----------
  function parseColor(str) {
    const s = String(str).trim();
    if (s === 'transparent') return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = s.match(/^color\(srgb ([^)]*)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;   // oklch() 等其他格式：不換算，回報 unknown
  }
  const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a) + 0.05, y = lum(b) + 0.05; return Math.max(x, y) / Math.min(x, y); };

  function splitTop(list) {          // 以最外層逗號切開 background-image 的各層
    const out = []; let depth = 0, start = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === '(') depth++;
      else if (list[i] === ')') depth--;
      else if (list[i] === ',' && !depth) { out.push(list.slice(start, i).trim()); start = i + 1; }
    }
    out.push(list.slice(start).trim());
    return out.filter(x => x && x !== 'none');
  }
  // 一層背景 → 可能出現的顏色（漸層取色標與相鄰色標的中點）；null 表示無法判斷。
  function layerColors(layer) {
    // 若瀏覽器把 color-mix(in srgb, X p%, transparent) 原樣留在計算值裡，換成等值的半透明色。
    layer = layer.replace(/color-mix\(in srgb, (rgba?\([^)]*\)) ([\d.]+)%, transparent\)/g, (_, c, p) => {
      const v = parseColor(c);
      return v ? `rgba(${v[0]}, ${v[1]}, ${v[2]}, ${v[3] * p / 100})` : _;
    });
    if (!/gradient\(/.test(layer) || /url\(|image-set\(|color-mix\(/.test(layer)) return null;
    const stops = (layer.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)|\btransparent\b/g) || []).map(parseColor);
    if (!stops.length || stops.some(c => !c)) return null;
    const out = [stops[0]];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i], alpha = (a[3] + b[3]) / 2;
      const mid = alpha ? [0, 1, 2].map(k => (a[k] * a[3] + b[k] * b[3]) / 2 / alpha).concat(alpha) : [0, 0, 0, 0];
      out.push(mid, b);
    }
    return out;
  }
  function stack(el) {               // 由上而下的背景層；遇到不透明就停
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      const own = [];
      for (const layer of splitTop(cs.backgroundImage)) {
        const colors = layerColors(layer);
        if (!colors) return null;
        own.push(colors);
      }
      const bg = parseColor(cs.backgroundColor);
      if (!bg) return null;
      if (bg[3] > 0) own.push([bg]);
      for (const colors of own) {
        layers.push(colors);
        if (colors.every(c => c[3] >= 0.999)) return layers;
      }
    }
    return layers.concat([[[255, 255, 255, 1]]]);   // deck-stage 畫布是白色
  }
  function grounds(layers) {
    let out = layers[layers.length - 1].map(c => c.slice(0, 3).concat(1));
    for (let i = layers.length - 2; i >= 0; i--) {
      const next = new Map();
      for (const base of out) for (const c of layers[i]) {
        const mixed = over(c, base);
        next.set(mixed.map(Math.round).join(), mixed);
      }
      out = [...next.values()];
      if (out.length > 256) out = out.sort((a, b) => lum(a) - lum(b)).filter((_, k, all) => k % Math.ceil(all.length / 256) === 0);
    }
    return out;
  }
  // SVG 圖形不是文字的祖先：找畫在文字底下、同一個 <svg> 裡的形狀。
  function svgUnder(el, r) {
    const svg = el.ownerSVGElement, layers = [];
    for (const hit of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) {
      if (hit === el || el.contains(hit)) continue;
      if (!(hit instanceof SVGGeometryElement) || hit.ownerSVGElement !== svg) continue;
      const cs = getComputedStyle(hit);
      if (cs.fill === 'none') continue;
      const c = parseColor(cs.fill);
      if (!c) return null;
      c[3] *= parseFloat(cs.fillOpacity) * parseFloat(cs.opacity);
      layers.push([c]);
      if (c[3] >= 0.999) break;
    }
    return { layers, from: svg };
  }
  function textContrast(el, r) {
    const cs = getComputedStyle(el);
    let fills;
    const clipText = (cs.webkitBackgroundClip || cs.backgroundClip) === 'text';
    if (clipText) fills = splitTop(cs.backgroundImage).flatMap(l => layerColors(l) || [null]);
    else fills = [parseColor(el instanceof SVGElement ? cs.fill : cs.color)];
    if (!fills.length || fills.some(c => !c)) return null;
    let opacity = 1;
    for (let n = el; n && !n.classList?.contains('slide'); n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    let layers = [], from = clipText ? el.parentElement : el;
    if (el instanceof SVGElement) {
      const under = svgUnder(el, r);
      if (!under) return null;
      layers = under.layers; from = under.from;
    }
    const rest = layers.some(l => l.every(c => c[3] >= 0.999)) ? [] : stack(from);
    if (!rest) return null;
    let worst = Infinity;
    for (const bg of grounds(layers.concat(rest))) for (const f of fills) {
      worst = Math.min(worst, ratio(over([f[0], f[1], f[2], f[3] * opacity], bg), bg));
    }
    return worst;
  }

  function check(slide, number) {
    const frame = slide.getBoundingClientRect();
    const scale = frame.width / slide.offsetWidth || 1;   // 舞台縮放；換回設計像素用
    const small = [], overflow = [], low = [], note = [], unknown = [];
    const seenSmall = new Set(), seenContrast = new Set();
    const roles = window.deckThemeRules?.roles;
    const fontScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--deck-font-scale')) || 1;

    for (const node of textNodes(slide)) {
      const el = node.parentElement;
      let size = parseFloat(getComputedStyle(el).fontSize);
      const svg = el.closest('svg');
      if (svg && el instanceof SVGElement) {
        const ctm = el.getScreenCTM();
        if (ctm) size *= Math.hypot(ctm.a, ctm.b) / scale;   // viewBox 縮放後的實際大小
      }
      if (size < FLOOR - 0.5 && !seenSmall.has(el)) {
        seenSmall.add(el);
        small.push(`${number} ${describe(el)} ${Math.round(size)}px`);
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (roles && !seenContrast.has(el) && r.width && r.height) {
        seenContrast.add(el);
        const c = textContrast(el, r);
        if (c === null) unknown.push(`${number} ${describe(el)}`);
        else if (c < roles.label.wcag - 0.005) low.push(`${number} ${describe(el)} ${c.toFixed(2)}:1`);
        else if (Math.abs(size / fontScale - 40) <= 2 && c < roles.body.wcag - 0.005) note.push(`${number} ${describe(el)} ${c.toFixed(2)}:1`);
      }
      const out = Math.max(frame.left - r.left, r.right - frame.right,
                           frame.top - r.top, r.bottom - frame.bottom) / scale;
      if (out > 1) overflow.push(`${number} ${describe(el)} 出框 ${Math.round(out)}px`);
    }

    // 內容區塞不下時會往上下溢出、壓到頁首；設了 overflow 的容器（如 .card）則會把文字裁掉。
    // 投影片本身不在此列：它的背景動畫本來就超出框，出框的文字已由上面逐字檢查。
    for (const el of slide.querySelectorAll('*')) {
      if (el.closest('[aria-hidden="true"], svg, ' + EXEMPT)) continue;
      const style = getComputedStyle(el);
      const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
      if (!clips && !el.classList.contains('content')) continue;
      let extra = Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth);
      if (!clips) {
        // .content 置中：塞不下時上下各溢出一半，scrollHeight 只看得到往下那一半，改量子元素。
        const box = el.getBoundingClientRect();
        for (const child of el.children) {
          const r = child.getBoundingClientRect();
          extra = Math.max(extra, (box.top - r.top) / scale, (r.bottom - box.bottom) / scale);
        }
      }
      if (extra > 2) overflow.push(`${number} ${describe(el)} ${clips ? '被裁' : '溢出'} ${Math.round(extra)}px`);
    }
    return { small, overflow, low, note, unknown };
  }

  function publish() {
    const small = [], overflow = [], low = [], note = [], unknown = [];
    for (const r of results.values()) {
      small.push(...r.small); overflow.push(...r.overflow); low.push(...r.low); note.push(...r.note); unknown.push(...r.unknown);
    }
    const data = document.body.dataset;
    data.minfont = small.length ? 'small' : 'ok';
    data.minfontBad = small.join('; ');
    data.overflow = overflow.length ? 'found' : 'none';
    data.overflowBad = overflow.join('; ');
    data.contrast = !window.deckThemeRules ? 'unchecked' : low.length ? 'low' : 'ok';
    data.contrastBad = low.join('; ');
    data.contrastNote = note.join('; ');
    data.contrastUnknown = unknown.join('; ');
    data.checked = [...results.keys()].sort((a, b) => a - b).join(',');
  }

  let pending = 0;
  async function settle(slide, number) {
    const ticket = ++pending;
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    // 只等有限長度的動畫（進場）；.flow／.pulse 這類無限迴圈不等。
    const finite = slide.getAnimations({ subtree: true })
      .filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime));
    await Promise.all(finite.map(a => a.finished.catch(() => {})));
    await new Promise(requestAnimationFrame);
    if (ticket !== pending || !slide.hasAttribute('data-deck-active')) return;   // 已換頁
    const r = check(slide, number);
    results.set(number, r);
    publish();
    for (const line of [...r.small, ...r.overflow]) console.warn('[deck-check]', line);
    for (const line of r.low) console.warn('[deck-check] 對比不足', line);
    for (const line of r.note) console.info('[deck-check] 內文對比 < body 門檻', line);
    for (const line of r.unknown) console.info('[deck-check] 對比無法判斷', line);
  }

  let current = null;
  document.addEventListener('slidechange', (event) => {
    const { slide, index } = event.detail || {};
    if (!slide) return;
    current = { slide, number: index + 1 };
    results.delete(index + 1);               // 重新進場：等這次檢查完才算數
    publish();
    settle(slide, index + 1);
  });

  // +／− 改 <html> 的 --deck-font-scale，c／g 改 data-deck-theme 與行內配色；舊結果都作廢。
  new MutationObserver(() => {
    results.clear();
    publish();
    if (current) settle(current.slide, current.number);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-deck-theme'] });

  console.info(`[deck-check] #debug：每到一頁檢查字級 ≥ ${FLOOR}px、溢出與對比，結果見 document.body.dataset`);
})();
