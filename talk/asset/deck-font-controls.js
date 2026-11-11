/* 全份簡報共用字級；與瀏覽器本身的縮放及換頁快捷鍵分開。 */
(() => {
  const deck = document.querySelector('deck-stage');
  if (!deck) return;

  const minimum = 80, maximum = 150, step = 10;
  const storageKey = `deck-font-size:${location.pathname}`;
  const thumbnail = new URLSearchParams(location.search).has('_snthumb');
  let percent = 100, timer;

  const status = document.createElement('output');
  status.className = 'deck-font-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  if (!thumbnail) document.body.append(status);

  function apply(value, announce = false) {
    const parsed = Number(value);
    percent = Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
      ? Math.round(parsed / step) * step : 100;
    document.documentElement.style.setProperty('--deck-font-scale', percent / 100);
    deck.dataset.fontSize = String(percent);
    if (announce && !thumbnail) {
      status.textContent = `字級 ${percent}%${percent === minimum ? '（最小）' : percent === maximum ? '（最大）' : ''}`;
      status.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { status.hidden = true; }, 2200);
    }
  }

  try { apply(localStorage.getItem(storageKey)); }
  catch { apply(100); }

  function nudge(direction) {
    apply(Math.max(minimum, Math.min(maximum, percent + direction * step)), true);
    try { localStorage.setItem(storageKey, String(percent)); }
    catch { /* 禁止儲存時仍可在目前視窗調整。 */ }
  }

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.composedPath().some(target => target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const direction = event.key === '+' || event.key === '=' ? 1 : event.key === '-' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    nudge(direction);
  });

  window.addEventListener('message', (event) => {
    if (event.data?.deckFontDirection === 1 || event.data?.deckFontDirection === -1) {
      nudge(event.data.deckFontDirection);
    }
  });

  // 同一份簡報的其他視窗與講者縮圖同步，查詢參數不另開一份設定。
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) apply(event.newValue);
  });
})();
