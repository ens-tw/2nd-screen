/* deck-math.js — typeset \( … \) formulas offline with the bundled KaTeX (asset/katex/).
 *
 * deck-compile writes the storyboard's 公式 column as a `p.fx` line in \( … \) delimiters;
 * this runs once, before deck-stage starts, so thumbnails, print and #debug see typeset
 * math. Only \( … \) is a delimiter, because `$` also appears in ordinary slide text
 * (prices, shell lines) and would be misread as math. A deck without KaTeX loaded, or a
 * formula KaTeX cannot parse, leaves the source text on the slide instead of failing.
 */
(function () {
  if (typeof window.renderMathInElement !== 'function') return;
  const root = document.querySelector('deck-stage') || document.body;
  window.renderMathInElement(root, {
    delimiters: [{ left: '\\(', right: '\\)', display: false }],
    throwOnError: false,
    output: 'html',
  });
})();
