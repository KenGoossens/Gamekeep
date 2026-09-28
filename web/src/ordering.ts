/**
 * One order for every list of servers.
 *
 * The lists used to show whatever order the config file happened to be in,
 * which reads as random and means the thing you came to look at -- a server
 * that is up, with people on it -- can be anywhere on the page.
 *
 * Running first, then by name. Name rather than player count or uptime,
 * because a list that reshuffles itself while you are reading it is worse
 * than one that is merely unsorted: the tile you were about to click moves
 * out from under you every time someone joins.
 */
export function byRunningThenName<T extends { running: boolean; name: string }>(
  a: T,
  b: T,
): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Whether a server matches what someone typed.
 *
 * Matches the name and the game, so "valheim" finds it whether that is what
 * you called the server or just what it runs. Case and surrounding space are
 * ignored, because nobody means them.
 */
export function matchesSearch(
  query: string,
  server: { name: string; game?: string | null; notes?: string | null },
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [server.name, server.game, server.notes]
    .filter((v): v is string => typeof v === 'string')
    .some((v) => v.toLowerCase().includes(needle));
}
