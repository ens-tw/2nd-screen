/* deck-motion.js — deck-svg 的活潑模式（選用的漸進增強），GSAP 3.15 版；要先載 asset/gsap.min.js。
   沒有這支腳本、沒載 gsap.min.js、或在簡報裡按 M 關掉，deck 就是原本的靜態簡報；它只讀投影片上的幾個 data- 屬性：

   data-beat="n"          第 n 拍出現（0 = 進頁時）。→ 先播拍，拍播完才換頁；← 退一拍（瞬間），退到底才回上一頁（全展開）。
                          Shift+← 動畫式倒退一拍、Shift+→ 重播這拍、[ ] 全域變速、D 把這拍拉成可拖的時間軸（GSDevTools，排拍時看節奏用）。
   data-fx                fadeup（預設）｜pop｜draw（SVG 線條畫出）｜type（逐字打出，純文字元素）｜count（數字遞增，從元素文字抓數字）｜hold（瞬間）
                          ｜chars（逐字彈入）｜lines（整行從遮罩下升起）｜scramble（亂碼解出：data-chars 指定亂碼字元，預設有數字就用 0-9、否則用自己的字）
   data-delay、data-dur   秒；同一拍裡用 delay 錯開。
   data-id="x"            跨頁延續：進頁時同名元素從前一頁（找不到就往更早的頁找）的位置與大小滑過來（Flip），所以元素「不消失只改位置」。
   data-morph="n:#sel …"  第 n 拍把這個 SVG path 變形成同頁 #sel 的形狀（目標 path 自己藏起來，例如 stroke:none；可列多拍）。
   data-relayout="n:cls …" 第 n 拍把這個容器加上 class cls（拿掉前一步的），裡面的子元素用 Flip 從舊位置飛到新位置，寬高、字級、內距一起補間。
   <section data-enter>   進頁轉場：fade（預設）｜push｜zoom；zoom 配 data-zoom-from="<data-id>"，鏡頭從前一頁那個元素推入。
   data-along="<selector>" 沿該頁某條 SVG 路徑循環移動（流動封包），data-period 秒；加 data-rotate 讓元素的 +x 軸跟著路徑轉向。

   拍數隨鏡頭緩推 4%。縮圖（?_snthumb）、#debug、列印一律全展開、不轉場，所以 deck-check 與 PDF 看到的是完整的頁。
   prefers-reduced-motion 下全部瞬間完成。
   它攔 deck-stage 的 deckstep 事件（可取消）而不改換頁本身，runtime 因此不認識「拍」，這支腳本整支拔掉也不影響簡報。
   標了 data-beat 的元素會被拿掉 .rise／.dN，因為 .rise 的 CSS 動畫會蓋過行內樣式，兩者只能擇一。
   每拍是進到那一拍時現做的 timeline（Flip 要在換版面的當下量）；退一拍＝把那拍的元素藏回去、文字、形狀與版面還原。
   只用 opacity（不用 visibility）藏元素，因為 deck.css 的列印規則只把 opacity 強制回 1。
   載入順序：gsap.min.js 之後、deck-stage.js 之前（和 deck-check.js 一樣要在 hash 被改寫前讀到 #debug）。 */
(() => {
  if (!window.gsap) { console.warn('deck-motion.js：asset/gsap.min.js 沒載入，活潑模式停用'); return; }
  const HAS = (n) => !!window[n];
  gsap.registerPlugin(...['Flip', 'DrawSVGPlugin', 'TextPlugin', 'SplitText', 'MorphSVGPlugin', 'MotionPathPlugin', 'ScrambleTextPlugin', 'GSDevTools'].filter(HAS).map((n) => window[n]));
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const THUMB = /[?&]_snthumb=/.test(location.search);
  const DEBUG = /(^#|[#&])debug(&|$)/.test(location.hash);
  const REVEAL = THUMB || DEBUG;
  const KEY = 'deck-motion.' + location.pathname;
  const EASE = 'power3.out';
  const CLEAR = 'opacity,transform,x,y,scale,scaleX,scaleY,rotate,translate,transformOrigin,strokeDasharray,strokeDashoffset';
  // 作者寫在元素 style 上、又在 CLEAR 裡的值（虛線、變形）：clearProps 會連同清掉，所以解析時記下、清完還原。
  // opacity 不還原：未到的拍靠樣式表的 opacity:0 藏起來，行內值會蓋過它讓元素提早露出。
  const KEEP = ['transform', 'translate', 'scale', 'rotate', 'transform-origin', 'stroke-dasharray', 'stroke-dashoffset'];
  const keepInline = (el) => KEEP.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]).filter((k) => k[1]);
  const restoreInline = (it) => { for (const [p, v, pr] of it.inline) it.el.style.setProperty(p, v, pr); };
  const clearItem = (it) => { gsap.set(it.el, { clearProps: CLEAR }); restoreInline(it); };
  const TRANS = { fade: 1, push: 1, zoom: 1 };
  const q = (sel, root) => { try { return root.querySelector(sel); } catch (e) { return null; } };
  if (RM) gsap.globalTimeline.timeScale(1e3);

  // ---- 每頁的拍：解析一次，存在 WeakMap ----
  const parsed = new WeakMap();
  function parse(slide) {
    if (parsed.has(slide)) return parsed.get(slide);
    const items = [], relayouts = [];
    const make = (el, beat) => {
      el.classList.remove('rise', 'd1', 'd2', 'd3', 'd4');
      const it = { el, beat, inline: keepInline(el), delay: parseFloat(el.dataset.delay) || 0, dur: el.dataset.dur != null ? parseFloat(el.dataset.dur) : .6, fx: FX[el.dataset.fx] ? el.dataset.fx : 'fadeup', text: el.textContent, morphs: [], split: null };
      if (it.fx === 'draw') el.removeAttribute('pathLength');   // DrawSVG 自己量長度，pathLength 會讓 dasharray 的單位對不上
      if (it.fx === 'count') {
        const m = /^([^\d]*)(\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(it.text.trim());
        if (m) {
          const dec = (m[2].split('.')[1] || '').length, grp = m[2].includes(',');
          it.n = parseFloat(m[2].replace(/,/g, ''));
          it.fmt = (v) => m[1] + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grp }) + m[3];
        } else it.fx = 'fadeup';
      }
      if (it.fx === 'scramble') it.chars = el.dataset.chars || (/\d/.test(it.text) ? '0123456789' : it.text.replace(/\s/g, '') || 'x');
      if (el.dataset.morph && el.tagName.toLowerCase() === 'path') {
        it.origD = el.getAttribute('d');
        it.morphs = el.dataset.morph.split(/\s+/).map((s) => { const i = s.indexOf(':'); const t = i > 0 && q(s.slice(i + 1), slide); return t ? { beat: parseInt(s, 10) || 0, d: t.getAttribute('d') } : null; }).filter(Boolean).sort((a, b) => a.beat - b.beat);
      }
      if (el.dataset.along) it.along = { sel: el.dataset.along, period: parseFloat(el.dataset.period) || 3, rotate: el.dataset.rotate != null };
      items.push(it);
      return it;
    };
    slide.querySelectorAll('[data-beat]').forEach((el) => make(el, parseInt(el.dataset.beat, 10) || 0));
    slide.querySelectorAll('[data-along]:not([data-beat])').forEach((el) => { make(el, 0).fx = 'hold'; });
    slide.querySelectorAll('[data-relayout]').forEach((el) => relayouts.push({ el, base: el.className, steps: el.dataset.relayout.split(/\s+/).map((s) => { const i = s.indexOf(':'); return i > 0 ? { beat: parseInt(s, 10) || 0, cls: s.slice(i + 1) } : null; }).filter(Boolean).sort((a, b) => a.beat - b.beat) }));
    const beats = Math.max(0, ...items.map((i) => i.beat), ...items.flatMap((i) => i.morphs.map((m) => m.beat)), ...relayouts.flatMap((r) => r.steps.map((s) => s.beat)));
    const P = { items, relayouts, beats };
    parsed.set(slide, P);
    return P;
  }
  // 第 b 拍時容器該是哪個 class、path 該是哪個形狀（b < 0 ＝ 原狀）
  const classAt = (r, b) => { let cls = null; for (const s of r.steps) if (s.beat <= b) cls = s.cls; return cls; };
  const setClass = (r, cls) => { r.el.className = cls ? r.base + ' ' + cls : r.base; };
  const shapeAt = (it, b) => { let d = it.origD; for (const m of it.morphs) if (m.beat <= b) d = m.d; return d; };
  const restoreText = (it) => { if (it.fx === 'type' || it.fx === 'count' || it.fx === 'scramble') it.el.textContent = it.text; };

  // ---- 效果：把這一拍的 tween 排進 timeline（at ＝ 拍內的 delay） ----
  const FX = {
    fadeup: (tl, it, at) => tl.fromTo(it.el, { opacity: 0, y: 36 }, { opacity: 1, y: 0, duration: it.dur, ease: EASE }, at),
    pop: (tl, it, at) => tl.fromTo(it.el, { opacity: 0, scale: .82, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: it.dur, ease: EASE }, at),
    hold: (tl, it, at) => tl.set(it.el, { opacity: 1 }, at),
    draw: (tl, it, at) => { tl.set(it.el, { opacity: 1 }, at); if (HAS('DrawSVGPlugin')) { tl.fromTo(it.el, { drawSVG: '0%' }, { drawSVG: '100%', duration: it.dur, ease: 'power2.inOut' }, at); if (it.inline.length) tl.call(() => restoreInline(it), null, at + it.dur); } },
    type: (tl, it, at) => { tl.set(it.el, { opacity: 1 }, at); if (HAS('TextPlugin')) { it.el.textContent = ''; tl.to(it.el, { text: { value: it.text }, duration: it.dur, ease: 'none' }, at); } },
    count: (tl, it, at) => { const o = { v: 0 }; tl.set(it.el, { opacity: 1 }, at); tl.to(o, { v: it.n, duration: it.dur, ease: EASE, onUpdate: () => { it.el.textContent = it.fmt(o.v); } }, at); },
    chars: (tl, it, at) => { if (!HAS('SplitText')) return FX.fadeup(tl, it, at); it.split = it.split || new SplitText(it.el, { type: 'chars' }); tl.set(it.el, { opacity: 1 }, at); tl.fromTo(it.split.chars, { opacity: 0, y: 24, scale: .9 }, { opacity: 1, y: 0, scale: 1, duration: .5, stagger: .04, ease: EASE }, at); },
    lines: (tl, it, at) => { if (!HAS('SplitText')) return FX.fadeup(tl, it, at); it.split = it.split || new SplitText(it.el, { type: 'lines', mask: 'lines' }); tl.set(it.el, { opacity: 1 }, at); tl.fromTo(it.split.lines, { yPercent: 110 }, { yPercent: 0, duration: it.dur + .3, stagger: .15, ease: 'power4.out' }, at); },
    scramble: (tl, it, at) => { if (!HAS('ScrambleTextPlugin')) return FX.fadeup(tl, it, at); tl.set(it.el, { opacity: 1 }, at); tl.to(it.el, { scrambleText: { text: it.text, chars: it.chars, speed: .4, revealDelay: it.dur * .3 }, duration: it.dur + .4 }, at); },
  };

  // ---- 狀態 ----
  let on = false, trans = null, stageEl = null, toastEl = null, toastTimer = 0, speed = 1, devOn = false, dev = null;
  let S = { slide: null, P: null, beat: 0, late: [], tls: new Map(), alongs: [] };
  const sections = () => (stageEl ? Array.from(stageEl.children).filter((c) => c.tagName === 'SECTION') : []);
  const index = () => sections().indexOf(S.slide);
  const announce = () => document.dispatchEvent(new CustomEvent('deckbeat', { detail: { beat: S.beat, beats: on && !REVEAL && S.P ? S.P.beats : 0, index: index() } }));

  // 這一拍的 timeline：現做（Flip 要在換版面的當下量）；instant ＝ 直接定到終態
  function build(b, instant) {
    const tl = gsap.timeline({ paused: true });
    for (const it of S.P.items) if (it.beat === b) FX[it.fx](tl, it, it.delay);
    for (const it of S.P.items) for (const m of it.morphs) if (m.beat === b) {
      if (instant || !HAS('MorphSVGPlugin')) tl.set(it.el, { attr: { d: m.d } }, it.delay);
      else tl.to(it.el, { morphSVG: m.d, duration: Math.max(it.dur, .8), ease: 'power2.inOut' }, it.delay);
    }
    for (const r of S.P.relayouts) for (const st of r.steps) if (st.beat === b) {
      if (instant || !HAS('Flip')) { setClass(r, st.cls); continue; }
      const state = Flip.getState(r.el.children, { props: 'fontSize,padding,borderRadius' });
      setClass(r, st.cls);
      tl.add(Flip.from(state, { duration: .9, ease: 'power2.inOut', absolute: true, stagger: .03, props: 'fontSize,padding,borderRadius', onEnter: (els) => gsap.fromTo(els, { opacity: 0 }, { opacity: 1, duration: .5, delay: .5 }), onLeave: (els) => gsap.to(els, { opacity: 0, duration: .25 }) }), 0);
    }
    // 跨頁延續、但不是第 0 拍才出現的元素：到這拍才從上一頁的位置飛過來（Flip 結束會寫回呼叫當下的 opacity，所以先顯示）
    for (const f of S.late) if (f.beat === b && HAS('Flip')) { gsap.set(f.el, { opacity: 1 }); tl.add(Flip.from(f.state, { targets: f.el, scale: true, duration: .8, ease: 'power2.inOut' }), 0); }
    return tl;
  }
  function instantBeat(b) { const tl = build(b, true); tl.progress(1); S.tls.set(b, tl); }
  function playBeat(b) { const tl = build(b, false); S.tls.set(b, tl); tl.play(); attachDev(); }
  // 退一拍（瞬間）：元素藏回去（CSS 在 html[data-deck-motion] 下把 [data-beat] 設成 opacity:0）、文字、形狀與版面還原
  function undoBeat(b) {
    const tl = S.tls.get(b); if (tl) tl.kill(); S.tls.delete(b);
    for (const it of S.P.items) {
      if (it.beat === b) { gsap.killTweensOf(it.el); clearItem(it); restoreText(it); if (it.split) gsap.set(it.split.chars.length ? it.split.chars : it.split.lines, { clearProps: 'all' }); }
      if (it.morphs.some((m) => m.beat === b)) it.el.setAttribute('d', shapeAt(it, b - 1));
    }
    for (const r of S.P.relayouts) if (r.steps.some((s) => s.beat === b)) setClass(r, classAt(r, b - 1));
  }
  // Shift+←：有 timeline 就倒放，放完再用 undoBeat 收乾淨（版面與形狀回到前一拍）
  function reverseBeat(b) {
    const tl = S.tls.get(b);
    if (tl && tl.progress() > 0) { tl.eventCallback('onReverseComplete', () => { if (S.tls.get(b) === tl) undoBeat(b); }); tl.reverse(); } else undoBeat(b);
  }
  // 整頁回到原狀：把播過的痕跡清掉；之後要嘛逐拍重定（on），要嘛全展開（off／縮圖／#debug）
  function reset() {
    for (const it of S.P.items) {
      gsap.killTweensOf(it.el);
      if (it.split) { it.split.revert(); it.split = null; }
      clearItem(it); restoreText(it);
      if (it.morphs.length) it.el.setAttribute('d', it.origD);
    }
    for (const r of S.P.relayouts) setClass(r, null);
    S.tls.forEach((tl) => tl.kill()); S.tls = new Map(); S.late = [];
  }
  function revealAll() {   // 全展開：版面與形狀停在最後一拍（opacity 由 CSS 處理：off 時沒有 html[data-deck-motion]，什麼都不藏）
    reset();
    for (const it of S.P.items) if (it.morphs.length) it.el.setAttribute('d', shapeAt(it, Infinity));
    for (const r of S.P.relayouts) setClass(r, classAt(r, Infinity));
  }
  function camera(instant) {
    if (!on || REVEAL || !S.slide) return;
    gsap.to(S.slide, { scale: 1 + .04 * (S.P.beats ? S.beat / S.P.beats : 0), transformOrigin: '50% 50%', duration: instant ? 0 : .8, ease: 'power2.out', overwrite: 'auto' });
  }
  function startAlong() {
    if (RM || !on || REVEAL || !HAS('MotionPathPlugin')) return;
    for (const it of S.P.items) if (it.along) {
      const path = q(it.along.sel, S.slide); if (!path || !path.getTotalLength) continue;
      S.alongs.push(gsap.to(it.el, { motionPath: { path, align: path, alignOrigin: [.5, .5], autoRotate: it.along.rotate }, duration: it.along.period, ease: 'none', repeat: -1 }));
    }
  }
  function leave() {
    if (!S.slide) return;
    killDev(); S.alongs.forEach((t) => t.kill()); S.tls.forEach((tl) => tl.kill());
    gsap.killTweensOf(S.slide); gsap.set(S.slide, { clearProps: 'transform,transformOrigin' });
  }
  // mode：play ＝ 前面的拍瞬間定好、這一拍播；instant ＝ 到這一拍為止全部瞬間；transition ＝ 什麼都先不定，第 0 拍由轉場在中途播
  function setSlide(slide, beat, mode) {
    if (S.slide !== slide) leave();
    S = { slide, P: parse(slide), beat: 0, late: [], tls: new Map(), alongs: [] };
    if (REVEAL || !on) { revealAll(); announce(); return; }
    reset();
    S.beat = Math.min(beat, S.P.beats);
    const upto = mode === 'transition' ? -1 : mode === 'play' ? S.beat - 1 : S.beat;
    for (let b = 0; b <= upto; b++) instantBeat(b);
    if (mode === 'play') playBeat(S.beat);
    startAlong(); camera(mode !== 'play'); announce();
  }

  // ---- 跨頁延續的來源：前一頁，找不到就往更早的頁找（非當前頁只是 visibility:hidden，量得到） ----
  function findSource(id, slide, prev) {
    const sel = `[data-id="${CSS.escape(id)}"]`;
    if (prev) { const s = q(sel, prev); if (s) return { el: s, inPrev: true }; }
    const all = sections(), i = all.indexOf(slide);
    for (let k = i - 1; k >= 0; k--) { if (all[k] === prev) continue; const s = q(sel, all[k]); if (s) return { el: s, inPrev: false }; }
    return null;
  }

  // ---- 轉場：前一頁暫時留在畫面上一起動；同 data-id 的元素用 Flip 滑過來 ----
  function startTransition(prev, slide) {
    const type = TRANS[slide.dataset.enter] ? slide.dataset.enter : 'fade';
    const pairs = [];
    if (HAS('Flip')) slide.querySelectorAll('[data-id]').forEach((e) => {
      const src = findSource(e.dataset.id, slide, prev); if (!src) return;
      const it = S.P.items.find((i) => i.el === e); if (it) it.fx = 'hold';
      pairs.push({ e, src: src.el, adjacent: src.inPrev, beat: it ? it.beat : 0 });
    });
    gsap.set(prev, { clearProps: 'transform,transformOrigin' });   // 鏡頭緩推會讓量到的位置偏
    const state = pairs.length ? Flip.getState(pairs.map((p) => p.src)) : null;
    pairs.filter((p) => p.adjacent).forEach((p) => { p.hid = p.src.style.opacity; p.src.style.opacity = 0; });
    S.late = pairs.filter((p) => p.beat > 0).map((p) => ({ el: p.e, beat: p.beat, state }));
    const now = pairs.filter((p) => p.beat === 0).map((p) => p.e);
    let origin = '50% 50%';
    if (type === 'zoom' && slide.dataset.zoomFrom) {
      const t = q(`[data-id="${CSS.escape(slide.dataset.zoomFrom)}"]`, prev);
      if (t) { const r = t.getBoundingClientRect(), s = prev.getBoundingClientRect(); origin = `${(r.left + r.width / 2 - s.left) / s.width * 100}% ${(r.top + r.height / 2 - s.top) / s.height * 100}%`; }
    }
    gsap.set(prev, { visibility: 'visible', opacity: 1, zIndex: 2, pointerEvents: 'none', transformOrigin: origin });
    gsap.set(slide, { zIndex: 1, opacity: 0 });
    const tl = gsap.timeline({ onComplete: () => finishTransition() });
    if (type === 'fade') tl.to(prev, { opacity: 0, scale: 1.04, duration: .3, ease: 'power1.in' }, 0).to(slide, { opacity: 1, duration: .42, ease: 'power1.out' }, .18);
    else if (type === 'push') tl.to(prev, { opacity: 0, x: -120, scale: 1.04, duration: .35, ease: 'power2.in' }, 0).fromTo(slide, { x: 120 }, { x: 0, opacity: 1, duration: .5, ease: 'power2.out' }, .2);
    else tl.to(prev, { scale: 2.64, duration: .8, ease: 'power3.in' }, 0).to(prev, { opacity: 0, duration: .5, ease: 'power1.in' }, .1).fromTo(slide, { scale: .96 }, { scale: 1, opacity: 1, duration: .6, ease: 'power2.out' }, .2);
    if (now.length) { gsap.set(now, { opacity: 1 }); tl.add(Flip.from(state, { targets: now, scale: true, duration: .7, ease: 'power2.inOut' }), .05); }
    tl.call(() => { if (trans && trans.tl === tl) playBeat(0); }, null, .25);
    trans = { tl, prev, slide, pairs, played: false };
  }
  function finishTransition() {
    const T = trans; if (!T) return; trans = null;
    if (T.tl.progress() < 1) T.tl.progress(1);   // 中途被打斷：直接定到終態（第 0 拍的 call 也會在這時跑）
    T.pairs.filter((p) => p.adjacent).forEach((p) => { p.src.style.opacity = p.hid; });
    gsap.set(T.prev, { clearProps: 'visibility,opacity,zIndex,pointerEvents,transform,transformOrigin,x,scale' });
    gsap.set(T.slide, { clearProps: 'zIndex,opacity,x,scale' });
    camera(false);
  }

  // ---- GSDevTools（D）：把目前這拍的 timeline 拉成可拖的時間軸，排拍時看節奏用 ----
  function killDev() { if (dev) { dev.kill(); dev = null; } }
  function attachDev() { killDev(); const tl = S.tls.get(S.beat); if (devOn && tl && HAS('GSDevTools')) { tl.vars.id = `第 ${index() + 1} 頁 · 第 ${S.beat} 拍`; dev = GSDevTools.create({ animation: tl, keyboard: false, globalSync: false, persist: false }); } }

  // ---- 與 deck-stage 的接點 ----
  document.addEventListener('deckstep', (e) => {
    if (!on || REVEAL || !S.slide) return;
    if (trans) { finishTransition(); e.preventDefault(); return; }
    const d = e.detail && e.detail.direction;
    if (d > 0 && S.beat < S.P.beats) { S.beat++; playBeat(S.beat); camera(false); announce(); e.preventDefault(); }
    else if (d < 0 && S.beat > 0) { undoBeat(S.beat); S.beat--; killDev(); attachDev(); camera(false); announce(); e.preventDefault(); }
  });
  document.addEventListener('slidechange', (e) => {
    const d = e.detail || {}; if (!d.slide) return;
    stageEl = stageEl || document.querySelector('deck-stage');
    if (trans) finishTransition();
    const forward = d.previousSlide && d.index > d.previousIndex;
    if (on && !REVEAL && forward) { setSlide(d.slide, 0, 'transition'); startTransition(d.previousSlide, d.slide); }
    else setSlide(d.slide, d.previousSlide && d.index < d.previousIndex ? Infinity : 0, d.previousSlide ? 'instant' : 'play');
  });

  function toast(text) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.style.cssText = 'position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:2147483647;padding:10px 18px;border-radius:6px;background:rgba(0,0,0,.82);color:#fff;font:16px/1.4 system-ui,sans-serif;pointer-events:none;transition:opacity .3s'; document.body.appendChild(toastEl); }
    toastEl.textContent = text; toastEl.style.opacity = '1';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1500);
  }
  function setOn(v) {
    on = v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {}
    document.documentElement.toggleAttribute('data-deck-motion', v);
    if (!v) { finishTransition(); killDev(); if (S.slide) { const keep = S.beat; leave(); S.alongs = []; revealAll(); S.beat = keep; } }
    else if (S.slide) setSlide(S.slide, S.beat, 'instant');
    announce();
    toast(on ? '活潑模式：開（→ 逐拍）' : '活潑模式：關');
  }
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'm' || e.key === 'M') { setOn(!on); e.preventDefault(); return; }
    if (!on || REVEAL || !S.slide) return;
    if (e.shiftKey && e.key === 'ArrowLeft') { if (trans) finishTransition(); else if (S.beat > 0) { reverseBeat(S.beat); S.beat--; killDev(); camera(false); announce(); } else return; }   // 退到底交給 runtime 回上一頁
    else if (e.shiftKey && e.key === 'ArrowRight') { if (trans) finishTransition(); else { undoBeat(S.beat); playBeat(S.beat); } }
    else if (e.key === '[' || e.key === ']') { speed = e.key === '[' ? Math.max(.25, speed / 2) : Math.min(4, speed * 2); if (!RM) gsap.globalTimeline.timeScale(speed); toast(`速度 ×${speed}`); }
    else if ((e.key === 'd' || e.key === 'D') && HAS('GSDevTools')) { devOn = !devOn; attachDev(); toast(devOn ? '時間軸工具：開（拖著看這一拍）' : '時間軸工具：關'); }
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);   // capture：要搶在 deck-stage 的 ←／→ 之前
  window.addEventListener('message', (e) => { if (e.data && e.data.deckMotionKey) setOn(!on); });

  function init() {
    stageEl = document.querySelector('deck-stage');
    document.querySelectorAll('deck-stage [data-id]').forEach((e) => { e.dataset.flipId = e.dataset.id; });   // Flip 用 data-flip-id 配對
    let stored = null; try { stored = localStorage.getItem(KEY); } catch (e) {}
    const authored = document.documentElement.hasAttribute('data-deck-motion') || !!document.querySelector('deck-stage [data-beat]');
    on = !REVEAL && (stored == null ? authored : stored === '1');
    document.documentElement.toggleAttribute('data-deck-motion', on);
    if (S.slide) setSlide(S.slide, 0, 'play');   // deck-stage 的第一個 slidechange 可能比 DOMContentLoaded 早：那時 on 還是 false，第一頁被當成靜態頁，要重定一次
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
