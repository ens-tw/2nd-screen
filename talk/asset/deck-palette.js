/* house-style 配色核心：檢查（與 scripts/check-contrast.py 同一套算法）與種子隨機配色。
   規則全部來自 deck-theme-rules.js（window.deckThemeRules）；這裡不寫任何門檻數字，
   因為兩份規則遲早會不一致。瀏覽器中掛在 window.deckPalette，Node 中以 require 取得。 */
(function (root) {
  'use strict';
  const CVD = {   // Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  };

  // ---------------------------------------------------------------- colours
  function parseColor(value) {
    const v = String(value).trim().toLowerCase();
    if (v[0] === '#') {
      let h = v.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
      if (h.length !== 6 && h.length !== 8) throw new Error('bad colour ' + value);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
              h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    const m = v.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
      const p = m[1].trim().split(/[\s,/]+/).filter(Boolean);
      const rgb = p.slice(0, 3).map(x => x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x));
      const a = p.length > 3 ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
      return [...rgb, a];
    }
    throw new Error('unsupported colour (use #hex or rgb()/rgba()): ' + value);
  }
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const luminance = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  function contrast(fg, bg, ambient = 0) {
    const a = luminance(fg) + 0.05 + ambient, b = luminance(bg) + 0.05 + ambient;
    return Math.max(a, b) / Math.min(a, b);
  }
  function apca(fg, bg) {   // APCA-W3 0.0.98G-4g
    const y = c => {
      const v = 0.2126729 * Math.pow(c[0] / 255, 2.4) + 0.7151522 * Math.pow(c[1] / 255, 2.4)
              + 0.0721750 * Math.pow(c[2] / 255, 2.4);
      return v > 0.022 ? v : v + Math.pow(0.022 - v, 1.414);
    };
    const yt = y(fg), yb = y(bg);
    if (Math.abs(yb - yt) < 0.0005) return 0;
    if (yb > yt) { const s = (Math.pow(yb, 0.56) - Math.pow(yt, 0.57)) * 1.14; return s < 0.1 ? 0 : (s - 0.027) * 100; }
    const s = (Math.pow(yb, 0.65) - Math.pow(yt, 0.62)) * 1.14;
    return s > -0.1 ? 0 : (s + 0.027) * 100;
  }
  function lab(c, vision) {
    let rgb = [lin(c[0]), lin(c[1]), lin(c[2])];
    if (CVD[vision]) rgb = CVD[vision].map(row => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
    const [r, g, b] = rgb;
    const xyz = [0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
                 0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
                 0.0193339 * r + 0.1191920 * g + 0.9503041 * b];
    const f = t => t > 216 / 24389 ? Math.pow(t, 1 / 3) : (24389 / 27 * t + 16) / 116;
    const [fx, fy, fz] = [f(xyz[0] / 0.95047), f(xyz[1] / 1.0), f(xyz[2] / 1.08883)];
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function ciede2000([l1, a1, b1], [l2, a2, b2]) {
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const g = 0.5 * (1 - Math.sqrt(Math.pow(cb, 7) / (Math.pow(cb, 7) + Math.pow(25, 7))));
    const a1p = (1 + g) * a1, a2p = (1 + g) * a2;
    const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
    const mod = (x, n) => ((x % n) + n) % n;
    const h1p = mod(Math.atan2(b1, a1p) * deg, 360), h2p = mod(Math.atan2(b2, a2p) * deg, 360);
    const dl = l2 - l1, dc = c2p - c1p;
    const dh = c1p * c2p === 0 ? 0 : mod(h2p - h1p + 180, 360) - 180;
    const dhh = 2 * Math.sqrt(c1p * c2p) * Math.sin(dh / 2 * rad);
    const lbp = (l1 + l2) / 2, cbp = (c1p + c2p) / 2;
    let hbp;
    if (c1p * c2p === 0) hbp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    const t = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
            + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
    const dth = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const rc = 2 * Math.sqrt(Math.pow(cbp, 7) / (Math.pow(cbp, 7) + Math.pow(25, 7)));
    const sl = 1 + 0.015 * Math.pow(lbp - 50, 2) / Math.sqrt(20 + Math.pow(lbp - 50, 2));
    const sc = 1 + 0.045 * cbp, sh = 1 + 0.015 * cbp * t;
    const rt = -Math.sin(2 * dth * rad) * rc;
    return Math.sqrt(Math.pow(dl / sl, 2) + Math.pow(dc / sc, 2) + Math.pow(dhh / sh, 2) + rt * (dc / sc) * (dhh / sh));
  }

  // ------------------------------------------------- surfaces, pairs, check
  function surfaceColor(name, t, rules, seen = 0) {
    if (seen > 8) throw new Error('surface loop at ' + name);
    const layers = rules.surfaces[name];
    if (!layers) throw new Error('unknown surface ' + name);
    let base = null;
    for (const layer of layers) {
      let col;
      if (layer !== name && rules.surfaces[layer]) col = surfaceColor(layer, t, rules, seen + 1);
      else {
        const [tok, share] = layer.split('@');
        col = t[tok].slice();
        if (share) col[3] *= parseFloat(share);
      }
      base = base ? over(col, base) : (col[3] < 1 ? over(col, [255, 255, 255, 1]) : col);
    }
    return base;
  }
  // The expanded pair list depends only on the rules, so it is built once per rules object.
  const plans = new WeakMap();
  function plan(rules) {
    if (plans.has(rules)) return plans.get(rules);
    const surfaces = {}, list = [], seen = new Set();
    const subber = c => (c ? n => n.replace('C', c) : n => n);
    for (const name of Object.keys(rules.surfaces)) {
      if (name === 'why') continue;
      for (const c of name.includes('C') ? rules.chapters : [null]) {
        const sub = subber(c);
        surfaces[sub(name)] = rules.surfaces[name].map(sub);
      }
    }
    for (const p of rules.pairs) {
      const usesC = p.text.concat(p.on).some(x => x.includes('C'));
      for (const c of usesC ? rules.chapters : [null]) {
        const sub = subber(c);
        for (const fg of new Set(p.text.map(sub))) for (const g of new Set(p.on.map(sub))) {
          const label = `${fg}/${g}`;
          if (!seen.has(label)) { seen.add(label); list.push([p.role, label, fg, g]); }
        }
      }
    }
    const out = { surfaces: Object.assign({}, rules, { surfaces }), list };
    plans.set(rules, out);
    return out;
  }
  // (role, label, text colour, ground) for every pair the rules list, C expanded per
  // chapter; `only` keeps the pairs whose label names that token.
  function pairs(t, rules, only) {
    const { surfaces, list } = plan(rules);
    const out = [];
    for (const [role, label, fg, g] of list) {
      if (only && !label.split('/').includes(only)) continue;
      out.push([role, label, t[fg], surfaceColor(g, t, surfaces)]);
    }
    return out;
  }
  function check(decls, rules) {
    const missing = rules.tokens.concat(rules.otherTokens).filter(k => !(k in decls));
    if (missing.length) return { ok: false, fails: ['missing tokens: ' + missing.map(k => '--' + k).join(', ')], worst: {} };
    const t = {};
    for (const k of rules.tokens) t[k] = parseColor(decls[k]);
    const fails = [], worst = {};
    const keep = (key, value, label) => { if (!(key in worst) || value < worst[key][0]) worst[key] = [value, label]; };
    for (let [role, label, fg, bg] of pairs(t, rules)) {
      if (fg[3] < 1) fg = over(fg, bg);
      const r = rules.roles[role];
      for (const [kind, ratio, floor] of [['wcag', contrast(fg, bg), r.wcag],
                                          ['lit', contrast(fg, bg, rules.ambient.luminance), r.ambient]]) {
        keep(`${kind}-${role}`, ratio, label);
        if (ratio < floor) fails.push(`${label} ${kind} ${ratio.toFixed(2)} < ${floor}`);
      }
      if (role === 'body') keep('apca', Math.abs(apca(fg, bg)), label);
    }
    const ch = rules.chapters;
    for (const vision of rules.cvd.visions) {
      for (let i = 0; i < ch.length; i++) for (let j = i + 1; j < ch.length; j++) {
        const d = ciede2000(lab(t[ch[i]], vision), lab(t[ch[j]], vision));
        keep('de', d, `${ch[i]}/${ch[j]} ${vision}`);
        if (d < rules.cvd.deltaE00) fails.push(`${ch[i]}/${ch[j]} ΔE00 ${d.toFixed(1)} < ${rules.cvd.deltaE00} (${vision})`);
      }
    }
    return { ok: !fails.length, fails, worst, light: luminance(t.ink) > 0.5 };
  }

  // ------------------------------------------------------------ generator
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function oklchToLinear(L, C, h) {
    const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  const gamma = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  // Out-of-gamut colours keep lightness and hue and lose chroma until they fit sRGB.
  function oklch(L, C, h) {
    let lo = 0, hi = C, rgb = oklchToLinear(L, C, h);
    const inGamut = v => v.every(x => x >= -1e-6 && x <= 1 + 1e-6);
    if (!inGamut(rgb)) {
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid; }
      rgb = oklchToLinear(L, lo, h);
    }
    return rgb.map(x => Math.round(gamma(Math.min(1, Math.max(0, x))))).concat(1);
  }
  const hex = c => '#' + c.slice(0, 3).map(x => x.toString(16).padStart(2, '0')).join('');
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const lerp = ([a, b], t) => a + (b - a) * t;

  // Lightest/darkest lightness of hue h that still passes every pair of `role`
  // the token takes part in: walk from the most contrasting end towards the ground.
  function solveLightness(token, from, to, C, h, base, rules, extra) {
    let best = null;
    const steps = 60;
    for (let i = 0; i <= steps; i++) {
      const L = from + (to - from) * i / steps;
      const t = Object.assign({}, base, { [token]: oklch(L, C, h) });
      if (passes(t, rules, extra, token)) best = L; else if (best !== null) break;
    }
    return best;
  }
  function passes(t, rules, margin, token) {
    for (let [role, label, fg, bg] of pairs(t, rules, token)) {
      if (fg[3] < 1) fg = over(fg, bg);
      const r = rules.roles[role];
      if (contrast(fg, bg) < r.wcag * (1 + margin)) return false;
      if (contrast(fg, bg, rules.ambient.luminance) < r.ambient * (1 + margin)) return false;
    }
    return true;
  }

  function build(rnd, rules, mode) {
    const G = rules.generator, M = G[mode], dark = mode === 'dark';
    const hBg = rnd() * 360, cBg = lerp(G.inkChroma, rnd()), Lk = lerp(M.ink, rnd());
    const t = {
      ink: oklch(Lk, cBg, hBg),
      'ink-2': oklch(dark ? Lk + 0.025 : Math.min(0.997, Lk + 0.03), cBg * (dark ? 1 : 0.4), hBg),
      'ink-3': oklch(dark ? Lk + 0.05 : Math.min(0.995, Lk + 0.018), cBg * (dark ? 1 : 0.6), hBg),
      text: oklch(M.text, G.textChroma, hBg),
    };
    t.body = t.text; t.muted = t.text;
    t['on-chapter'] = dark ? t.ink : [255, 255, 255, 1];
    t.glow = [0, 0, 0, 0];
    // Chapter hues: evenly spread, each moved by at most half the slack, so
    // neighbours never come closer than generator.hueSpacing degrees.
    const n = rules.chapters.length, step = 360 / n, slack = Math.max(0, step - G.hueSpacing);
    const h0 = rnd() * 360;
    const [lo, hi] = G.accentLightness[mode];
    const chosen = [];
    // Among each chapter's hue/lightness/chroma variants that pass their pairs, take the one farthest (min CIEDE2000 over every vision)
    // from the chapters already chosen, so colour-blind distinctness is built in.
    const labs = c => rules.cvd.visions.map(v => lab(c, v));
    const distance = (x, y) => Math.min(...x.map((l, k) => ciede2000(l, y[k])));
    rules.chapters.forEach((c, i) => {
      const C = lerp(G.accentChroma, rnd()), pick = rnd();
      const ok = [];
      for (const jitter of [-0.5, 0, 0.5]) for (const share of [1, 0.75, 0.5]) for (let k = 0; k <= 30; k++) {
        const cand = oklch(lo + (hi - lo) * k / 30, C * share, (h0 + i * step + jitter * slack + 360) % 360);
        const tt = Object.assign({}, t, { [c]: cand, accent: cand, 'accent-soft': [cand[0], cand[1], cand[2], 0.1],
                                          'title-from': t.text, 'title-to': t.text,
                                          'hair': t.text, 'hair-soft': t.text, 'art-line': t.text, 'art-glow': t.text });
        for (const other of rules.chapters) if (!tt[other]) tt[other] = cand;
        if (passes(tt, rules, G.margin, c)) ok.push(cand);
      }
      if (!ok.length) { t[c] = null; return; }
      let best = ok[Math.min(ok.length - 1, Math.floor(pick * ok.length))], bestD = -1;
      if (chosen.length) {
        for (const cand of ok) {
          const l = labs(cand), d = Math.min(...chosen.map(x => distance(l, x)));
          if (d > bestD) { bestD = d; best = cand; }
        }
      }
      t[c] = best;
      chosen.push(labs(best));
    });
    if (rules.chapters.some(c => !t[c])) return null;
    const c1 = t[rules.chapters[0]], c2 = t[rules.chapters[1]];
    t.accent = c1;
    t['accent-soft'] = [c1[0], c1[1], c1[2], dark ? 0.16 : 0.1];
    t.glow = [c2[0], c2[1], c2[2], dark ? 0.06 : 0.05];
    t['title-from'] = t.text; t['title-to'] = t.text;
    t.hair = t['hair-soft'] = t['art-line'] = t['art-glow'] = t.text;   // placeholders while solving
    // Body and muted: the least extreme lightness that still clears their role
    // with the margin, so hierarchy comes from lightness and contrast is by construction.
    const toward = Lk, fromL = M.text;
    const Lb = solveLightness('body', fromL, toward, G.textChroma, hBg, t, rules, G.margin);
    if (Lb === null) return null;
    t.body = oklch(Lb, G.textChroma, hBg);
    const Lm = solveLightness('muted', fromL, toward, G.textChroma, hBg, t, rules, G.margin);
    if (Lm === null) return null;
    t.muted = oklch(Lm, G.textChroma, hBg);
    t['title-to'] = t.body;
    const tc = t.text;
    const out = {};
    for (const k of rules.tokens) out[k] = hex(t[k]);
    Object.assign(out, {
      'accent-soft': rgba(c1, dark ? 0.16 : 0.1), glow: rgba(c2, dark ? 0.06 : 0.05),
      'art-glow': dark ? hex(c1) : rgba(c1, 0.35), hair: rgba(tc, dark ? 0.12 : 0.16), 'hair-soft': rgba(tc, dark ? 0.06 : 0.07), 'art-line': rgba(tc, dark ? 0.13 : 0.12),
      'shadow-lg': dark ? '0 22px 60px rgba(0,0,0,.55)' : '0 14px 40px rgba(0,0,0,.12)',
    });
    return out;
  }

  // Same seed → same palette: the PRNG is the only source of randomness, and a
  // failed verification draws the next attempt from the same stream.
  function generate(seed, rules) {
    const rnd = mulberry32(seed >>> 0);
    // Light or dark is fixed per seed, so retries cannot drift towards the easier mode.
    const mode = rnd() < 0.5 ? 'light' : 'dark';
    for (let attempt = 1; attempt <= rules.generator.attempts; attempt++) {
      const tokens = build(rnd, rules, mode);
      if (!tokens) continue;
      tokens['theme-name'] = `"隨機 #${seed}"`;
      if (check(tokens, rules).ok) return { tokens, attempt };
    }
    return null;
  }

  function css(id, tokens, rules) {
    const keys = ['theme-name'].concat(rules.tokens, ['shadow-lg']);
    return `:root[data-deck-theme="${id}"] {\n` + keys.map(k => `  --${k}: ${tokens[k]};`).join('\n') + '\n}';
  }

  const api = { build, parseColor, luminance, contrast, apca, lab, ciede2000, pairs, check, mulberry32, oklch, generate, css };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.deckPalette = api;
})(typeof window !== 'undefined' ? window : this);
