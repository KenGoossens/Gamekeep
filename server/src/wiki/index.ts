/**
 * The built-in wiki: GameKeepr's own manual, served by the portal itself.
 *
 * Pages are markdown files shipped with the app and listed here by hand --
 * a manifest in code rather than front-matter in files, so the compiler
 * checks the roles and a typo in a page id is a build error, not a 404.
 *
 * Visibility follows the same three roles as everything else. A member reads
 * how to use the portal; an operator also reads how to run servers; an owner
 * also reads how to set the platform up and what the security model is. A
 * page someone's role does not reach answers 404, not 403: the wiki describes
 * capabilities they do not have, and listing what is withheld is itself a
 * disclosure.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));
// Resolves to src/wiki/pages under tsx and dist/wiki/pages once built --
// the Dockerfile copies the pages next to the compiled module.
const PAGES_DIR = join(here, 'pages');

export interface WikiPageMeta {
  id: string;
  title: string;
  section: string;
  /** The least role that may read it. */
  role: Role;
}

const RANK: Record<Role, number> = { member: 0, operator: 1, owner: 2 };

/** Order here is display order, within and across sections. */
export const WIKI_PAGES: WikiPageMeta[] = [
  { id: 'welcome', title: 'Welcome to GameKeepr', section: 'Using GameKeepr', role: 'member' },
  { id: 'servers', title: 'Servers and restarting', section: 'Using GameKeepr', role: 'member' },
  { id: 'tournaments', title: 'Tournaments (beta)', section: 'Using GameKeepr', role: 'member' },
  { id: 'dashboard', title: 'The dashboard', section: 'Using GameKeepr', role: 'member' },
  { id: 'account', title: 'Your account', section: 'Using GameKeepr', role: 'member' },
  { id: 'roles', title: 'Roles and permissions', section: 'Using GameKeepr', role: 'member' },
  // Member-level on purpose, both of them: anyone the portal serves deserves
  // to read what it may send out and how to say something is broken.
  { id: 'reporting-issues', title: 'Reporting an issue', section: 'Using GameKeepr', role: 'member' },
  { id: 'statistics', title: 'Anonymous usage statistics', section: 'Using GameKeepr', role: 'member' },
  { id: 'installing', title: 'Installing game servers', section: 'Operating servers', role: 'operator' },
  { id: 'mods', title: 'Mods', section: 'Operating servers', role: 'operator' },
  { id: 'files-settings', title: 'Files and settings', section: 'Operating servers', role: 'operator' },
  { id: 'schedules', title: 'Schedules', section: 'Operating servers', role: 'operator' },
  { id: 'backups', title: 'Backups', section: 'Operating servers', role: 'operator' },
  { id: 'console-logs', title: 'Logs and the console', section: 'Operating servers', role: 'operator' },
  { id: 'networking', title: 'Networking and ports', section: 'Operating servers', role: 'operator' },
  { id: 'setup', title: 'Setting up from scratch', section: 'Administration', role: 'owner' },
  { id: 'access', title: 'Users, access and integrations', section: 'Administration', role: 'owner' },
  { id: 'security', title: 'The security model', section: 'Administration', role: 'owner' },
];

export function visiblePages(role: Role): WikiPageMeta[] {
  return WIKI_PAGES.filter((page) => RANK[role] >= RANK[page.role]);
}

export async function readPage(id: string, role: Role): Promise<{ meta: WikiPageMeta; markdown: string } | null> {
  const meta = WIKI_PAGES.find((page) => page.id === id);
  if (!meta || RANK[role] < RANK[meta.role]) return null;
  try {
    const markdown = await readFile(join(PAGES_DIR, `${id}.md`), 'utf8');
    return { meta, markdown };
  } catch {
    // A listed page whose file is missing is a packaging bug; said plainly.
    return { meta, markdown: `# ${meta.title}\n\nThis page is missing from the build.` };
  }
}
