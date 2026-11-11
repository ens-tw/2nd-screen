/* house-style 配色規則（唯一來源）。./fw check-contrast 與簡報內的 deck-palette.js 都讀這份；
   用 .js 包一層 JSON，因為 file:// 開啟的簡報不能 fetch 本地 JSON。等號後面必須是純 JSON。 */
window.deckThemeRules = {
  "version": 1,
  "chapters": ["c1", "c2", "c3", "c4"],
  "tokens": ["ink", "ink-2", "ink-3", "hair", "hair-soft", "text", "body", "muted", "accent", "accent-soft",
             "c1", "c2", "c3", "c4", "on-chapter", "glow", "title-from", "title-to", "art-line", "art-glow"],
  "otherTokens": ["theme-name", "shadow-lg"],
  "roles": {
    "body":  {"wcag": 7.0, "ambient": 4.5,
              "why": "Body and heading text is held above WCAG AA (4.5) because a projector washes contrast out and the back row gets one look."},
    "label": {"wcag": 4.5, "ambient": 3.0,
              "why": "Labels, muted and accent text are larger or bold and secondary, so WCAG AA is the floor; 3:1 lit is WCAG's large-text level."}
  },
  "ambient": {"luminance": 0.05,
              "why": "A lit room's light reflected by the screen, as a share of white, added to both luminances: it lifts a dark ground most, which is why dark themes lose more in daylight."},
  "apca": {"report": true, "why": "APCA-W3 0.0.98G-4g is reported, not gated, because it is still a draft standard."},
  "cvd": {"deltaE00": 10.0, "visions": ["normal", "deutan", "protan"],
          "why": "Chapter colours mark sections and sit side by side on cards and the top rail, so every pair must stay tellable apart (CIEDE2000 >= 10) for normal vision and Machado-2009 deuteranopia and protanopia."},
  "surfaces": {
    "why": "The opaque grounds deck.css paints, bottom layer first; 'X@a' is token X at a times its alpha, C stands for each chapter colour.",
    "ink": ["ink"],
    "ink-2": ["ink-2"],
    "ink-3": ["ink-3"],
    "hero": ["ink", "accent-soft"],
    "slide/C": ["ink", "glow", "C@0.11"],
    "quote/C": ["slide/C", "C@0.14"],
    "box/C": ["ink-2", "C@0.22"],
    "seg/C": ["ink-2", "C@0.55"],
    "C": ["C"]
  },
  "pairs": [
    {"role": "body",  "text": ["text", "body"], "on": ["ink", "ink-2", "ink-3", "slide/C", "hero", "quote/C"]},
    {"role": "label", "text": ["muted"], "on": ["ink", "ink-2", "ink-3", "slide/C"]},
    {"role": "label", "text": ["C"], "on": ["ink", "ink-2", "ink-3", "slide/C", "quote/C"]},
    {"role": "label", "text": ["on-chapter"], "on": ["C"]},
    {"role": "label", "text": ["text"], "on": ["box/C", "seg/C"]},
    {"role": "label", "text": ["title-from", "title-to", "accent"], "on": ["hero"]}
  ],
  "generator": {
    "why": "Construction ranges for seeded palettes (OKLCH). They shape the look; the gates above still verify every result, and the hand-tuned fixed themes are held only to the gates.",
    "light": {"ink": [0.955, 0.985], "text": 0.20},
    "dark":  {"ink": [0.12, 0.18], "text": 0.97},
    "inkChroma": [0.0, 0.03],
    "textChroma": 0.012,
    "accentChroma": [0.09, 0.17],
    "accentLightness": {"light": [0.30, 0.58], "dark": [0.62, 0.92]},
    "hueSpacing": 55,
    "margin": 0.15,
    "attempts": 40
  }
};
