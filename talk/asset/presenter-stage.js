/* deck-stage-presenter v8 — press P to spawn a child window with speaker
   notes + two iframe-based thumbnails (current + next) and a grid of all
   slides (O) to jump to a far one, built on the
   deck-stage v2 _snthumb URL contract. On an extended desktop, P opens the
   console on the laptop and the next P sends the deck fullscreen to the
   projector.

   Each thumbnail is an <iframe> loading the deck with `?_snthumb=1#<N>`:
     - `?_snthumb=...` is detected by deck-stage v2 (line ~566) and sets
       the `no-rail` attribute, so the iframe shows a clean stage with no
       editor rail and no scale offset.
     - `#<N>` (1-indexed) is parsed by `_restoreIndex` so the iframe lands
       on the requested slide.
   Iframes are loaded once at popup mount; subsequent slide changes call
   `deckStage.goTo(N)` cross-frame (same-origin happy path), with an
   `iframe.src = ...` reload fallback for browsers that block file:// →
   file:// frame access (notably Chrome's null-origin file:// policy). */
(() => {
  let p = null, notes = [], labels = [];
  let lastBeat = [0, 0]; // from deck-motion's deckbeat events; 0 beats = plain slide
  let projector = null; // the screen the next P sends the deck to, once the console sits on the laptop
  const stage = () => document.querySelector('deck-stage');

  function labelForSlide(s) {
    const explicit = s.getAttribute('data-label');
    if (explicit) return explicit;
    const screen = s.getAttribute('data-screen-label');
    if (screen) return screen.replace(/^\s*\d+\s*/, '').trim();
    const h = s.querySelector('h1, h2, h3, [data-title]');
    return h ? (h.textContent || '').trim().slice(0, 80) : '';
  }

  function load() {
    try { notes = JSON.parse(document.getElementById('speaker-notes').textContent) || []; } catch (e) { notes = []; }
    labels = Array.from(document.querySelectorAll('deck-stage > section')).map(labelForSlide);
  }

  function presenterDoc(deckUrl) {
    return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><title>Presenter — Speaker Notes</title>
<style>
:root{--paper:oklch(0.985 0.004 85);--paper-2:oklch(0.965 0.006 85);--ink:oklch(0.18 0.012 265);--ink-2:oklch(0.34 0.012 265);--ink-3:oklch(0.55 0.010 265);--rule:oklch(0.84 0.008 85);--accent:oklch(0.50 0.15 25);--serif:"Noto Serif TC","Source Han Serif TC",serif;--sans:"Noto Sans TC",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace;}
html,body{margin:0;padding:0;height:100%;background:var(--paper);color:var(--ink);font-family:var(--sans);}
body{display:flex;flex-direction:column;padding:14px 20px 18px;box-sizing:border-box;gap:14px;}
.thumbs{display:flex;gap:8px;border-bottom:1px solid var(--rule);padding-bottom:10px;}
.thumb{flex:1 1 0;min-width:0;aspect-ratio:16/9;position:relative;cursor:pointer;border:1px solid var(--rule);border-radius:3px;background:#000;overflow:hidden;transition:border-color 120ms ease,box-shadow 120ms ease;}
.thumb:hover{border-color:var(--ink-3);}
.thumb[data-active]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);}
.thumb.empty{display:flex;align-items:center;justify-content:center;background:var(--paper-2);cursor:default;color:var(--ink-3);font-family:var(--mono);font-size:11px;letter-spacing:0.08em;border-color:var(--rule);}
.thumb iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;pointer-events:none;}
.thumb .meta{position:absolute;left:6px;top:5px;display:flex;align-items:center;gap:6px;z-index:2;background:rgba(255,255,255,0.85);padding:2px 7px;border-radius:3px;max-width:calc(100% - 12px);}
.thumb .meta .k{font-family:var(--mono);font-size:9px;letter-spacing:0.10em;text-transform:uppercase;color:var(--accent);}
.thumb[data-kind="next"] .meta .k{color:var(--ink-3);}
.thumb .meta .num{font-family:var(--mono);font-size:10px;color:var(--ink-2);font-variant-numeric:tabular-nums;}
.thumb .meta .lbl{font-family:var(--sans);font-size:10px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:12px;}
.label{font-family:var(--mono);font-size:12px;letter-spacing:0.10em;color:var(--accent);text-transform:uppercase;}
.pn{font-family:var(--mono);font-size:13px;color:var(--ink-3);font-variant-numeric:tabular-nums;}
h1{font-family:var(--serif);font-size:22px;font-weight:600;margin:0;color:var(--ink);line-height:1.3;}
.note{font-family:var(--serif);font-size:17px;line-height:1.6;color:var(--ink-2);white-space:pre-wrap;flex:1;overflow-y:auto;min-height:0;}
.empty-note{color:var(--ink-3);font-style:italic;font-size:15px;}
.footer{border-top:1px solid var(--rule);padding-top:10px;font-family:var(--mono);font-size:11px;color:var(--ink-3);line-height:1.6;letter-spacing:0.02em;}
.place{padding:10px 14px;border:1px solid var(--accent);border-radius:4px;background:var(--paper-2);font-size:15px;color:var(--ink);}
.kbd{display:inline-block;padding:1px 6px;background:var(--paper-2);border:1px solid var(--rule);border-radius:3px;font-size:10px;color:var(--ink-2);margin:0 2px;}
.hr{display:flex;align-items:baseline;gap:14px;}
.gridbtn{font-family:var(--mono);font-size:11px;letter-spacing:0.04em;padding:3px 8px;border:1px solid var(--rule);border-radius:3px;background:var(--paper);color:var(--ink-2);cursor:pointer;}
.gridbtn:hover{border-color:var(--ink-3);}
#grid{position:fixed;inset:0;z-index:10;background:var(--paper);display:flex;flex-direction:column;gap:12px;padding:14px 20px 18px;box-sizing:border-box;}
#grid[hidden]{display:none;}
.ghead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:1px solid var(--rule);padding-bottom:10px;}
#gridList{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px 14px;align-content:start;padding:6px;}
.tile{cursor:pointer;display:flex;flex-direction:column;gap:5px;min-width:0;}
.tile .frame{position:relative;aspect-ratio:16/9;border:1px solid var(--rule);border-radius:3px;background:#000;overflow:hidden;}
.tile iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;pointer-events:none;}
.tile:hover .frame{border-color:var(--ink-3);}
.tile[data-current] .frame{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent);}
.tile[data-sel] .frame{outline:3px solid var(--ink);outline-offset:3px;}
.tile .cap{display:flex;gap:8px;align-items:baseline;min-width:0;}
.tile .num{font-family:var(--mono);font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.tile[data-current] .num{color:var(--accent);}
.tile .lbl{font-size:13px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
</style></head><body>
<div class="thumbs" id="thumbs"></div>
<div class="place" id="place" hidden>下一步：按 <span class="kbd">P</span>，投影片會全螢幕到投影幕。若投影片先跳到前面，再按一次 <span class="kbd">P</span>。</div>
<header><span class="label">Speaker Notes</span><span class="hr"><button class="gridbtn" id="gridBtn" type="button">全部投影片 O</button><span class="pn"><span id="cur">—</span> / <span id="tot">?</span><span id="beat"></span></span></span></header>
<h1 id="title">—</h1>
<div class="note" id="note"><span class="empty-note">（無備註）</span></div>
<div class="footer"><span class="kbd">←</span><span class="kbd">→</span> 切換 ｜ <span class="kbd">Space</span> 下一頁 ｜ <span class="kbd">+</span><span class="kbd">−</span> 調整投影片字級 ｜ <span class="kbd">C</span> 換主題 <span class="kbd">G</span> 隨機配色（Shift 反向）｜ <span class="kbd">M</span> 活潑模式 ｜ <span class="kbd">R</span> 重置 ｜ 點縮圖跳頁 ｜ <span class="kbd">O</span> 全部投影片 ｜ <span class="kbd">Esc</span> 關閉視窗</div>
<div id="grid" hidden><div class="ghead"><span class="label">全部投影片</span><span class="pn">點一張跳過去 ｜ <span class="kbd">←</span><span class="kbd">→</span><span class="kbd">↑</span><span class="kbd">↓</span> 選 ｜ <span class="kbd">Enter</span> 跳頁 ｜ <span class="kbd">Esc</span> 返回</span></div><div id="gridList"></div></div>
<script>
const DECK_URL = ${JSON.stringify(deckUrl)};
let nN=[],lL=[],totalSlides=0,frames={current:null,next:null};
let grid=null,gridSel=0,gridCur=0;

function snthumbUrl(i){
  const u=new URL(DECK_URL);
  u.searchParams.set('_snthumb','1');
  u.hash=String(i+1);
  return u.toString();
}
function gotoInIframe(iframe,i){
  // Same-origin happy path: reach into the iframe's deck-stage and call
  // goTo. If access is blocked (Chrome file:// is null-origin and rejects
  // even sibling-file iframe.contentDocument), fall back to a src reload —
  // slower but always works.
  try{
    const w=iframe.contentWindow;
    const ds=w && w.document && w.document.querySelector('deck-stage');
    if(ds && typeof ds.goTo==='function'){ ds.goTo(i); return; }
  }catch(e){}
  // Fallback: setting src to a URL that differs only in #fragment is a
  // hash-nav, not a reload — deck-stage v2 reads the hash once on
  // connectedCallback so the iframe would stay on the previous slide.
  // Add a per-call _nav nonce so the URL differs by query param too,
  // which forces the browser to actually reload the iframe document.
  const u=new URL(snthumbUrl(i));
  u.searchParams.set('_nav',String(Date.now()));
  iframe.src=u.toString();
}
function buildThumb(i,kind,activeIdx){
  const isCurrent=kind==='current';
  if(i<0||i>=totalSlides){
    const e=document.createElement('div');
    e.className='thumb empty';
    e.dataset.kind=kind;
    e.textContent=(isCurrent?'目前':'下一張')+' ─';
    return {wrapper:e,iframe:null,index:-1};
  }
  const tb=document.createElement('div');
  tb.className='thumb';
  tb.dataset.kind=kind;
  tb.dataset.i=String(i);
  if(i===activeIdx) tb.setAttribute('data-active','');
  tb.title=lL[i]||('Slide '+(i+1));
  const meta=document.createElement('div'); meta.className='meta';
  const k=document.createElement('span'); k.className='k'; k.textContent=(isCurrent?'目前':'下一張');
  const num=document.createElement('span'); num.className='num'; num.textContent=String(i+1).padStart(2,'0');
  const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent=lL[i]||'';
  meta.append(k,num,lbl);
  const ifr=document.createElement('iframe');
  ifr.src=snthumbUrl(i);
  ifr.setAttribute('aria-hidden','true');
  ifr.setAttribute('tabindex','-1');
  ifr.dataset.i=String(i);
  tb.append(ifr,meta);
  tb.addEventListener('click',()=>{ if(window.opener && !window.opener.closed){ window.opener.postMessage({presenterGoto:i},'*'); } });
  return {wrapper:tb,iframe:ifr,index:i};
}
function updateSlot(slot,kind,idx,activeIdx){
  const cur=frames[slot];
  const inRange=idx>=0 && idx<totalSlides;
  const wasIframe=!!(cur && cur.iframe);
  // Empty<->populated transition: rebuild this slot.
  if(!cur || inRange!==wasIframe){
    const fresh=buildThumb(idx,kind,activeIdx);
    if(cur) cur.wrapper.replaceWith(fresh.wrapper);
    else document.getElementById('thumbs').appendChild(fresh.wrapper);
    frames[slot]=fresh;
    return;
  }
  if(!inRange) return; // both empty, nothing to do
  // Stays-iframe: update meta, retarget if slide index changed, refresh
  // active highlight + click handler.
  cur.wrapper.dataset.i=String(idx);
  cur.wrapper.title=lL[idx]||('Slide '+(idx+1));
  if(idx===activeIdx) cur.wrapper.setAttribute('data-active','');
  else cur.wrapper.removeAttribute('data-active');
  const num=cur.wrapper.querySelector('.meta .num');
  const lbl=cur.wrapper.querySelector('.meta .lbl');
  if(num) num.textContent=String(idx+1).padStart(2,'0');
  if(lbl) lbl.textContent=lL[idx]||'';
  if(parseInt(cur.iframe.dataset.i,10)!==idx){
    cur.iframe.dataset.i=String(idx);
    gotoInIframe(cur.iframe,idx);
  }
  cur.index=idx;
  cur.wrapper.onclick=()=>{ if(window.opener && !window.opener.closed){ window.opener.postMessage({presenterGoto:idx},'*'); } };
}
function renderThumbs(i){
  if(!frames.current && !frames.next){
    // First mount — clear and add both slots.
    const strip=document.getElementById('thumbs');
    strip.replaceChildren();
    updateSlot('current','current',i,i);
    updateSlot('next','next',i+1,i);
    return;
  }
  updateSlot('current','current',i,i);
  updateSlot('next','next',i+1,i);
}
// Slide grid (O): every slide as a thumbnail, so a far slide is one click
// away instead of a page at a time. Built on first open and kept; the
// iframes load lazily, so a long deck only loads the rows in view.
function toDeck(m){ if(window.opener && !window.opener.closed){ window.opener.postMessage(m,'*'); } }
function tiles(){ return document.querySelectorAll('#gridList .tile'); }
function buildGrid(){
  grid=document.getElementById('grid');
  const list=document.getElementById('gridList');
  for(let i=0;i<totalSlides;i++){
    const t=document.createElement('div');
    t.className='tile';
    t.title=lL[i]||('Slide '+(i+1));
    const f=document.createElement('div'); f.className='frame';
    const ifr=document.createElement('iframe');
    ifr.loading='lazy';
    ifr.src=snthumbUrl(i);
    ifr.setAttribute('aria-hidden','true');
    ifr.setAttribute('tabindex','-1');
    f.appendChild(ifr);
    const cap=document.createElement('div'); cap.className='cap';
    const num=document.createElement('span'); num.className='num'; num.textContent=String(i+1).padStart(2,'0');
    const lbl=document.createElement('span'); lbl.className='lbl'; lbl.textContent=lL[i]||'';
    cap.append(num,lbl);
    t.append(f,cap);
    t.addEventListener('click',()=>jumpTo(i));
    list.appendChild(t);
  }
}
function markGrid(){ tiles().forEach((t,i)=>{ t.toggleAttribute('data-current',i===gridCur); t.toggleAttribute('data-sel',i===gridSel); }); }
function gridOpen(){ return !!grid && !grid.hidden; }
function openGrid(){
  if(!totalSlides) return;
  if(!grid) buildGrid();
  grid.hidden=false;
  gridSel=gridCur;
  markGrid();
  tiles()[gridSel].scrollIntoView({block:'center'});
}
function closeGrid(){ if(grid) grid.hidden=true; }
function jumpTo(i){ toDeck({presenterGoto:i}); closeGrid(); }
function gridKey(k){
  const cols=getComputedStyle(document.getElementById('gridList')).gridTemplateColumns.split(' ').length;
  let n=gridSel;
  if(k==='Escape'||k==='o'||k==='O'){ closeGrid(); return; }
  if(k==='Enter'||k===' '){ jumpTo(gridSel); return; }
  if(k==='ArrowRight') n++;
  else if(k==='ArrowLeft') n--;
  else if(k==='ArrowDown') n+=cols;
  else if(k==='ArrowUp') n-=cols;
  else if(k==='Home') n=0;
  else if(k==='End') n=totalSlides-1;
  else return;
  gridSel=Math.max(0,Math.min(totalSlides-1,n));
  markGrid();
  tiles()[gridSel].scrollIntoView({block:'nearest'});
}
document.getElementById('gridBtn').addEventListener('click',(e)=>{ e.currentTarget.blur(); gridOpen()?closeGrid():openGrid(); });
window.addEventListener('message',(e)=>{
  const d=e.data;if(!d)return;
  if(d.init){
    nN=d.notes||[];
    lL=d.labels||[];
    totalSlides=lL.length;
    document.getElementById('tot').textContent=totalSlides;
    render(d.current||0);
  }
  else if(typeof d.slideIndexChanged==='number'){render(d.slideIndexChanged);}
  if(Array.isArray(d.deckBeat)){document.getElementById('beat').textContent=d.deckBeat[1]?' · 第 '+d.deckBeat[0]+' / '+d.deckBeat[1]+' 拍':'';}
  if(typeof d.placeHint==='boolean'){document.getElementById('place').hidden=!d.placeHint;}
});
function render(i){
  if(i<0||i>=lL.length)return;
  gridCur=i;
  if(grid) markGrid();
  document.getElementById('cur').textContent=i+1;
  document.getElementById('title').textContent=lL[i]||('Slide '+(i+1));
  const n=nN[i],el=document.getElementById('note');
  if(n&&String(n).trim()){el.textContent=n;}else{el.innerHTML='<span class="empty-note">（這張無備註）</span>';}
  renderThumbs(i);
}
window.addEventListener('keydown',(e)=>{if(e.metaKey||e.ctrlKey||e.altKey)return;if(gridOpen()){gridKey(e.key);e.preventDefault();return;}if(e.key==='o'||e.key==='O'){openGrid();e.preventDefault();return;}if(e.key==='Escape'){window.close();return;}const k=e.key;if(k==='p'||k==='P'){if(!document.getElementById('place').hidden&&window.opener&&!window.opener.closed){window.opener.focus();window.opener.postMessage({presenterPlace:true},'*');}e.preventDefault();return;}const direction=(k==='+'||k==='=')?1:k==='-'?-1:0;if(direction){if(window.opener&&!window.opener.closed){window.opener.postMessage({deckFontDirection:direction},'*');}e.preventDefault();return;}if(k==='m'||k==='M'){if(window.opener&&!window.opener.closed){window.opener.postMessage({deckMotionKey:true},'*');}e.preventDefault();return;}if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&/^[cg]$/i.test(k)){if(window.opener&&!window.opener.closed){window.opener.postMessage({deckThemeKey:e.shiftKey?k.toUpperCase():k.toLowerCase()},'*');}e.preventDefault();return;}if(['ArrowLeft','ArrowRight','PageDown','PageUp',' ','r','R','Home','End'].includes(k)){if(window.opener&&!window.opener.closed){window.opener.postMessage({presenterKey:k},'*');}e.preventDefault();}});
<\/script></body></html>`;
  }

  /* Two screens: the deck goes fullscreen on the external screen (the
     projector) and the console opens on the built-in one, so nothing is
     dragged across by hand. Uses the Window Management API (Chromium only).
     A desktop without a built-in
     screen keeps the console on the screen the deck was on.

     One key press grants one activation, and requestFullscreen and
     window.open each spend it: on a real two-screen Mac (Chrome, EPSON
     projector, permission granted) either order left the second step
     refused. So two screens take two presses, each doing one thing: the
     first opens the console on the laptop, the second, with the console
     open, sends the deck to the projector. A live test on 2026-10-08 showed
     Brave refuses or misplaces that second step (see docs/DESIGN.md), so
     this is a stopgap until window placement moves to an extension. The
     second press must land on the deck, since a key press in the console
     cannot make the deck fullscreen (Chrome refuses it, checked headless).
     If the console took focus, its P brings the deck forward and the deck
     asks for P once more.

     Chrome never stores the permission for a file:// page: the query says
     "prompt" and every getScreenDetails() call asks again. So the deck asks
     once per page load and keeps the live ScreenDetails it gets. If Allow is
     clicked while the key press still counts as user activation, that same
     press goes on to open the console; otherwise the next P does. */
  let details = null, asked = false;

  async function screens() {
    if (!window.getScreenDetails || !window.screen.isExtended) return null;
    if (!details && !asked) {
      asked = true;
      try { details = await window.getScreenDetails(); }
      catch (e) { console.warn('[presenter] two-screen placement skipped:', e); }
    }
    if (!details) return null;
    const consoleScreen = details.screens.find((s) => s.isInternal) || details.currentScreen;
    const projector = details.screens.find((s) => s !== consoleScreen);
    return projector ? { consoleScreen, projector } : null;
  }

  function fullscreenOn(projector) {
    return document.documentElement.requestFullscreen({ screen: projector })
      .then(() => true, (e) => { console.warn('[presenter] projector fullscreen failed:', e); return false; });
  }

  // An alert would take the deck out of fullscreen, so this says it on the slide.
  function notice(text) {
    const n = document.createElement('div');
    n.textContent = text;
    n.style.cssText = 'position:fixed;left:50%;bottom:6%;transform:translateX(-50%);z-index:2147483647;' +
      'padding:12px 20px;border-radius:6px;background:rgba(0,0,0,0.82);color:#fff;font:16px/1.4 system-ui,sans-serif;';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 4000);
  }

  const placeHint = () => !!projector && !document.fullscreenElement;

  async function openPresenter() {
    if (p && !p.closed) {
      if (placeHint()) {
        if (!await fullscreenOn(projector)) notice('投影片沒能全螢幕到投影幕，請再按一次 P。');
        return;
      }
      p.focus();
      return;
    }
    const place = await screens();
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      // The permission prompt outlasted this press; the next P opens the console.
      notice(place ? '已允許。再按一次 P，講者視窗會開在筆電螢幕。' : '再按一次 P，開講者視窗。');
      return;
    }
    projector = place && place.projector;
    const c = place && place.consoleScreen;
    const features = c
      ? `left=${c.availLeft},top=${c.availTop},width=${c.availWidth},height=${c.availHeight}`
      : 'width=960,height=1000';
    p = window.open('', 'deck-presenter', features);
    if (!p) {
      projector = null;
      if (document.fullscreenElement) notice('講者視窗被擋：請允許此頁的彈出式視窗，再按一次 P。');
      else alert('Presenter window blocked — please allow popups for this page and press P again.');
      return;
    }
    p.document.open();
    p.document.write(presenterDoc(document.URL));
    p.document.close();
    setTimeout(() => {
      const s = stage();
      if (p && !p.closed) p.postMessage({ init: true, notes, labels, current: s ? s.index : 0, placeHint: placeHint(), deckBeat: lastBeat }, '*');
    }, 80);
    // Keep the next P on the deck if the browser lets it; the console's P covers it if not.
    if (projector) window.focus();
  }

  function init() {
    load();
    const s = stage();
    if (s) {
      s.addEventListener('slidechange', (e) => {
        if (p && !p.closed) p.postMessage({ slideIndexChanged: e.detail.index }, '*');
      });
      // deck-motion.js (optional) reports the reveal step; the console shows 第 n/m 拍.
      document.addEventListener('deckbeat', (e) => {
        lastBeat = [e.detail.beat, e.detail.beats];
        if (p && !p.closed) p.postMessage({ deckBeat: lastBeat }, '*');
      });
    }
  }

  // The console's banner tracks whether the deck still has to go to the projector.
  document.addEventListener('fullscreenchange', () => {
    if (p && !p.closed) p.postMessage({ placeHint: placeHint() }, '*');
  });

  window.addEventListener('message', (e) => {
    if (!e.data) return;
    const s = stage();
    if (!s) return;
    if (e.data.presenterPlace) { if (placeHint()) notice('再按一次 P，投影片會全螢幕到投影幕。'); return; }
    if (typeof e.data.presenterGoto === 'number') { s.goTo(e.data.presenterGoto); return; }
    if (e.data.deckFontDirection === 1 || e.data.deckFontDirection === -1) return;
    if (!e.data.presenterKey) return;
    const k = e.data.presenterKey;
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') s.next();
    else if (k === 'ArrowLeft' || k === 'PageUp') s.prev();
    else if (k === 'Home') s.goTo(0);
    else if (k === 'End') s.goTo(s.length - 1);
    else if (k === 'r' || k === 'R') s.reset();
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); openPresenter(); }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
