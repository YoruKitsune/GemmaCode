/**
 * Скрипт, который выполняется в странице и строит для модели текстовый снимок: заголовки, текст и пронумерованные
 * элементы управления `[n]`. Номера живут до следующего снимка или перехода (`window.__gcRefs`).
 * Дерево доступности CDP дало бы больше шума: для маленькой модели важна короткая и стабильная выдача.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX_NODES = 6000;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[contenteditable=""],[contenteditable=true],[onclick]';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'CANVAS', 'PATH']);
  const refs = [];
  window.__gcRefs = refs;
  const out = [];
  let buf = '';
  let nodes = 0;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const flush = () => {
    const t = clean(buf);
    buf = '';
    if (t && t !== '-' && t !== '|') out.push(cut(t, 300));
  };
  const visible = (el) => {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'button';
  };
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al) return clean(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => l.textContent).join(' '));
      if (t) return t;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value) || (el.type === 'submit' ? 'Submit' : '');
    if (el.tagName === 'IMG') return clean(el.alt);
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    return clean(el.title || el.placeholder || el.getAttribute('name') || '');
  };
  const emitInteractive = (el) => {
    const id = refs.length + 1;
    refs.push(el);
    const role = roleOf(el);
    let line = '[' + id + '] ' + role;
    const name = nameOf(el);
    if (name) line += ' "' + cut(name, 80) + '"';
    if (role === 'link' && el.href) line += ' -> ' + cut(el.getAttribute('href') || el.href, 90);
    if (role === 'textbox' || role === 'slider') {
      const v = el.value !== undefined ? el.value : clean(el.textContent);
      line += el.type === 'password' ? ' value=(hidden)' : ' value="' + cut(String(v || ''), 80) + '"';
      if (el.placeholder && el.placeholder !== name) line += ' placeholder="' + cut(el.placeholder, 40) + '"';
    }
    if (role === 'checkbox' || role === 'radio') line += el.checked ? ' [checked]' : ' [unchecked]';
    if (role === 'select') {
      const opts = [...el.options].slice(0, 8).map((o) => clean(o.textContent));
      line += ' value="' + cut(clean(el.selectedOptions[0] ? el.selectedOptions[0].textContent : ''), 40) + '" options: ' + opts.join(' | ');
    }
    if (el.disabled) line += ' [disabled]';
    if (el.required) line += ' [required]';
    out.push(line);
  };
  const walk = (root) => {
    for (const c of root.childNodes) {
      if (++nodes > MAX_NODES) return;
      if (c.nodeType === 3) {
        buf += c.nodeValue;
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toUpperCase();
      if (SKIP.has(tag) || !visible(c)) continue;
      if (c.matches(INTERACTIVE)) {
        flush();
        emitInteractive(c);
        continue;
      }
      if (/^H[1-6]$/.test(tag) && !c.querySelector(INTERACTIVE)) {
        flush();
        const t = clean(c.innerText);
        if (t) out.push('#'.repeat(Number(tag[1])) + ' ' + cut(t, 200));
        continue;
      }
      if (tag === 'IMG') {
        const alt = clean(c.alt);
        if (alt) {
          flush();
          out.push('image "' + cut(alt, 80) + '"');
        }
        continue;
      }
      if (tag === 'IFRAME') {
        flush();
        out.push('(iframe ' + cut(c.getAttribute('src') || '', 80) + ' is not shown)');
        continue;
      }
      if (tag === 'BR') {
        flush();
        continue;
      }
      const inner = c.shadowRoot || c;
      if (tag === 'TD' || tag === 'TH') {
        walk(inner);
        buf += ' | ';
        continue;
      }
      const display = getComputedStyle(c).display;
      const block = !display.startsWith('inline') && display !== 'contents';
      if (block) flush();
      if (tag === 'LI') buf = '- ';
      walk(inner);
      if (block) {
        buf = buf.replace(/\s*\|\s*$/, '');
        flush();
      }
    }
  };
  walk(document.body || document.documentElement);
  flush();
  const total = Math.max(document.documentElement.scrollHeight, 1);
  const view = window.innerHeight;
  const y = Math.round(window.scrollY);
  return JSON.stringify({
    title: document.title,
    url: location.href,
    scroll: 'scrollY ' + y + ' of ' + (total - view > 0 ? total - view : 0) + ' (viewport ' + view + 'px, page ' + total + 'px)',
    lines: out,
    refs: refs.length,
    truncated: nodes > MAX_NODES,
  });
})()`;
