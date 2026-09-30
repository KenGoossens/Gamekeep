import { useEffect, useState } from 'react';
import { api, type WikiIndex } from '../api.ts';
import { renderMarkdown } from '../markdown.ts';
import { linkProps, navigate } from '../router.ts';

/**
 * The manual, inside the portal it describes.
 *
 * The sidebar only lists what the reader's role can do: a member sees how to
 * use the place, an operator also how to run it, an owner also how to build
 * it. That is the same rule as everywhere else -- the wiki does not advertise
 * capabilities the reader does not have.
 */
export function WikiPage({ pageId }: { pageId?: string }) {
  const [index, setIndex] = useState<WikiIndex | null>(null);
  const [page, setPage] = useState<{ id: string; title: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.wiki().then(
      (idx) => {
        setIndex(idx);
        // Landing on /wiki opens the first page rather than an empty pane.
        if (!pageId && idx.sections[0]?.pages[0]) {
          navigate(`/wiki/${idx.sections[0].pages[0].id}`);
        }
      },
      () => setError('Could not load the wiki.'),
    );
  }, [pageId]);

  useEffect(() => {
    if (!pageId) return;
    api.wikiPage(pageId).then(
      (p) => setPage({ id: p.id, title: p.title, html: renderMarkdown(p.markdown) }),
      () => setError('That page does not exist.'),
    );
  }, [pageId]);

  return (
    <>
      <div className="page-head">
        <h1>Wiki</h1>
        <p>How GameKeepr works — what you see here follows your role.</p>
      </div>

      <div className="wiki">
        <nav className="wiki-nav" aria-label="Wiki pages">
          {(index?.sections ?? []).map((section) => (
            <div key={section.section}>
              <h3>{section.section}</h3>
              <ul>
                {section.pages.map((p) => (
                  <li key={p.id}>
                    <a
                      {...linkProps(`/wiki/${p.id}`)}
                      aria-current={p.id === pageId ? 'page' : undefined}
                    >
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <article className="wiki-body card">
          {error ? <p className="hint bad">{error}</p> : null}
          {!page && !error ? <p className="empty">Loading…</p> : null}
          {page ? (
            /* The pages ship with GameKeepr and are escaped before any markdown
               styling is applied, so this is our own HTML, not anyone's input. */
            <div dangerouslySetInnerHTML={{ __html: page.html }} />
          ) : null}
        </article>
      </div>
    </>
  );
}
