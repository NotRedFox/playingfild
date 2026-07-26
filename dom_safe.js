// Safe DOM helpers — avoid direct innerHTML assignment in extension pages.

export function pfReplaceHtml(parent, html) {
  // Wrap the fragment in a full HTML document so BOTH real-browser
  // DOMParser and linkedom's (used by CI tests) return a populated
  // <body>. Historically we passed `<body>${html}</body>` — real
  // browsers coalesced the nested <body> silently, but linkedom drops
  // the duplicate and leaves doc.body empty. Historically the bare
  // fragment failed for the same reason on linkedom (nodes leaked
  // outside the parsed body). A full document wrapper works for both.
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body>${html == null ? '' : html}</body></html>`,
    'text/html'
  );
  parent.replaceChildren(...Array.from(doc.body.childNodes));
}

export function createElementWithText(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null && text !== '') el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function createParagraph(text, style) {
  const p = document.createElement('p');
  p.textContent = text;
  if (style) p.style.cssText = style;
  return p;
}

export function replaceDatalistOptions(datalist, values) {
  if (!datalist) return;
  const frag = document.createDocumentFragment();
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    frag.appendChild(opt);
  }
  datalist.replaceChildren(...frag.childNodes);
}

export function createSpinnerButtonContent() {
  const span = document.createElement('span');
  span.className = 'spinner';
  const frag = document.createDocumentFragment();
  frag.appendChild(span);
  frag.appendChild(document.createTextNode('Working...'));
  return frag;
}
