/**
 * Bakes each shipped Steam server's OS into servers.data.ts.
 *
 * Run from server/:  npx tsx scripts/enrich-steam-os.mts
 *
 * For every app in STEAM_SERVERS this asks SteamCMD's app info (through
 * api.steamcmd.net, the same source and the same classification code the
 * deploy preflight uses — inspectSteamApp is imported, not reimplemented, so
 * the baked value and the deploy-time judgement cannot drift apart) and
 * writes an `os` field into the entry: "linux", "windows", "both" or "none".
 * An app Steam no longer answers for keeps no field — unknown stays unknown.
 *
 * The result is browsing honesty: the catalogue can say "Windows-only — runs
 * through Wine" on the row, before anyone clicks Configure. The deploy still
 * inspects the app live and decides from that; this data never overrules it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STEAM_SERVERS } from '../src/steam/servers.data.js';
import { inspectSteamApp } from '../src/steam/appinfo.js';

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), '../src/steam/servers.data.ts');
const CONCURRENCY = 6;
const RETRIES = 3;

type Os = 'linux' | 'windows' | 'both' | 'none';

async function classify(appid: number): Promise<Os | undefined> {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const info = await inspectSteamApp(appid);
      if (info.linux && info.windows) return 'both';
      if (info.linux) return 'linux';
      if (info.windows) return 'windows';
      return 'none';
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Delisted or private: Steam will never answer. Unknown stays unknown.
      if (code === 'not-found' || code === 'bad-reference') return undefined;
      if (attempt === RETRIES) return undefined;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return undefined;
}

const results = new Map<number, Os>();
let done = 0;
const queue = [...STEAM_SERVERS.map((s) => s.appid)];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const appid = queue.shift();
      if (appid === undefined) return;
      const os = await classify(appid);
      if (os) results.set(appid, os);
      done += 1;
      if (done % 50 === 0) console.log(`${done}/${STEAM_SERVERS.length}…`);
    }
  }),
);

let text = await readFile(DATA_FILE, 'utf8');
let patched = 0;
text = text.replace(
  /^(\s*\{ appid: (\d+), .*?)(?:, os: "(?:linux|windows|both|none)")?( \},?)$/gm,
  (whole, head: string, id: string, tail: string) => {
    const os = results.get(Number(id));
    if (!os) return `${head}${tail}`;
    patched += 1;
    return `${head}, os: "${os}"${tail}`;
  },
);
const stamp = new Date().toISOString().slice(0, 10);
const stampLine = `export const OS_CAPTURE_DATE = '${stamp}';`;
text = /^export const OS_CAPTURE_DATE = .*$/m.test(text)
  ? text.replace(/^export const OS_CAPTURE_DATE = .*$/m, stampLine)
  : text.replace(/^export const SNAPSHOT_DATE = .*$/m, (line) => `${line}\n${stampLine}`);
await writeFile(DATA_FILE, text);

const counts: Record<string, number> = {};
for (const os of results.values()) counts[os] = (counts[os] ?? 0) + 1;
console.log(
  `Classified ${results.size} of ${STEAM_SERVERS.length} apps (${patched} entries written):`,
  counts,
  `${STEAM_SERVERS.length - results.size} unknown (no usable app info).`,
);
