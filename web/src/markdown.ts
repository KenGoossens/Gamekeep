/**
 * A markdown renderer the size of the problem.
 *
 * The wiki's pages ship with GameKeepr -- they are authored, not user input --
 * so this needs to cover the subset those pages actually use: headings, bold,
 * italic, inline code, fenced code blocks, links, lists, quotes, tables and
 * rules. Everything is HTML-escaped first, so even a future page with a
 * pasted snippet cannot smuggle markup in; a library for this would be the
 * only dependency in the whole frontend.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bold, italic, code and links inside one line of already-escaped text. */
function inline(text: string): string {
  return (
    text
      // Code first: nothing inside backticks is styled further.
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Images before links, or the link rule eats the ![..](..) syntax.
      // Only the wiki's own image route: the pages are ours, the rule is free.
      .replace(
        /!\[([^\]]*)\]\((\/api\/wiki\/images\/[A-Za-z0-9._-]+)\)/g,
        '<img class="wiki-shot" src="$2" alt="$1" loading="lazy" />',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Only harmless destinations: the pages are ours, but the rule is free.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g, (_m, label, href) =>
        href.startsWith('http')
          ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
          : `<a href="${href}">${label}</a>`,
      )
  );
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph.length = 0;
    }
  };

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = escapeHtml(raw);

    // Fenced code: verbatim until the closing fence.
    if (/^```/.test(raw)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(escapeHtml(lines[i]!)), i++;
      i++;
      out.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      flush();
      out.push('<hr />');
      i++;
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(inline(escapeHtml(lines[i]!.replace(/^>\s?/, ''))));
        i++;
      }
      out.push(`<blockquote><p>${quote.join(' ')}</p></blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flush();
      const ordered = /^\d+\.\s+/.test(line);
      const items: string[] = [];
      const pattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && pattern.test(lines[i]!)) {
        items.push(`<li>${inline(escapeHtml(lines[i]!.replace(pattern, '')))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    // A pipe table: a header row, a divider row, then data rows.
    if (/^\|.*\|\s*$/.test(raw) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inline(escapeHtml(c.trim())));
      const head = cells(raw);
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) {
        rows.push(`<tr>${cells(lines[i]!).map((c) => `<td>${c}</td>`).join('')}</tr>`);
        i++;
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
      );
      continue;
    }

    if (line.trim() === '') {
      flush();
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}
