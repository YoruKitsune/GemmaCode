import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const label = (lang ?? '').split(/\s/)[0] ?? '';
      return `<div class="code"><div class="code-bar"><span>${escapeHtml(label)}</span><button class="copy" data-copy>Копировать</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
    link({ href, text }) {
      return `<a href="${escapeHtml(href)}" data-ext="1">${text}</a>`;
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    if (!/^https?:/i.test(node.getAttribute('href') ?? '')) node.removeAttribute('href');
  }
});

const cache = new Map<string, string>();

/** Markdown ответа модели в безопасный HTML. Разметка очищается DOMPurify: текст приходит от модели и может содержать чужие данные. */
export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.parse(src, { async: false }) as string, { ADD_ATTR: ['data-copy', 'data-ext'] });
  if (cache.size > 300) cache.clear();
  cache.set(src, html);
  return html;
}
