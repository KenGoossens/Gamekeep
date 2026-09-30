/**
 * Steam Workshop items, for the games that fetch their own mods.
 *
 * These games do not take a mod as a file. The server is given a list of
 * Workshop ids in its own configuration and downloads them through SteamCMD on
 * the next start, which is why installing one here writes a config line rather
 * than unpacking an archive -- and why it only takes effect after a restart.
 * That also means the portal never holds the mod's code, so the archive
 * scanners have nothing to scan: what can be checked is who published it,
 * whether Steam has banned it, and whether it is even for this game.
 *
 * No API key. Steam's key-gated endpoints (IPublishedFileService) can search
 * the Workshop; this one cannot, and asking the operator to register for a key
 * before they can add a mod is a worse trade than pasting a link. Everything
 * below uses ISteamRemoteStorage, which is open.
 */

import { ModSourceError } from './sources.js';

const DETAILS =
  'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const ITEM_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=';
const PROFILE_URL = 'https://steamcommunity.com/profiles/';

export interface WorkshopItem {
  id: string;
  title: string;
  /**
   * The publisher's Steam id, not their name: resolving one to the other needs
   * a Web API key. The profile link is given so it is still one click to see
   * who they are.
   */
  authorId: string;
  authorUrl: string;
  url: string;
  /** The game this was published for; compared against the server's own. */
  appId: number;
  description: string;
  previewUrl: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  subscriptions: number | null;
  /** Steam removed it. Installing a banned item gets you a failed download. */
  banned: boolean;
  banReason: string | null;
  /**
   * Some games want a second, human-written id alongside the Workshop number
   * -- Project Zomboid's `Mods=` line, for instance. Publishers put it in the
   * description by convention and nowhere machine-readable, so this is scraped.
   * An empty list means it could not be found, never that there is none.
   */
  declaredModIds: string[];
}

interface SteamDetails {
  publishedfileid: string;
  result: number;
  creator?: string;
  consumer_app_id?: number;
  title?: string;
  description?: string;
  preview_url?: string;
  file_size?: string | number;
  time_updated?: number;
  subscriptions?: number;
  banned?: number;
  ban_reason?: string;
}

/**
 * Pulls the Workshop id out of whatever the operator pasted.
 *
 * A bare id, a full item URL, or one with extra query parameters -- sharing a
 * Workshop link almost always carries `&searchtext=` or a `l=` language along
 * with it, and refusing those would be pedantry.
 */
export function parseWorkshopReference(raw: string): string {
  const text = raw.trim();
  if (!text) throw new ModSourceError('Paste a Workshop link or id.', 'bad-reference');

  if (/^\d+$/.test(text)) {
    if (text.length > 20) {
      throw new ModSourceError('That is not a Workshop id.', 'bad-reference');
    }
    return text;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ModSourceError(
      'That is neither a Workshop id nor a link. Copy the address of the mod’s Workshop page.',
      'bad-reference',
    );
  }

  if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname)) {
    throw new ModSourceError(
      `${url.hostname} is not the Steam Workshop. Mods are only taken from steamcommunity.com.`,
      'bad-reference',
    );
  }

  const id = url.searchParams.get('id');
  if (!id || !/^\d{1,20}$/.test(id)) {
    throw new ModSourceError(
      'That Steam link has no item id in it. Open the mod’s own page and copy that address.',
      'bad-reference',
    );
  }
  return id;
}

/**
 * The id publishers write in their description, for the games that need one.
 *
 * Project Zomboid is the reason this exists: its `Mods=` line takes a name
 * from the mod's own mod.info, which the Workshop does not expose, so every
 * mod manager for it reads the same "Mod ID: x" line out of the description.
 * Several mods ship in one Workshop item and each declares its own, hence a
 * list. Order is preserved and duplicates dropped.
 */
export function scrapeModIds(description: string): string[] {
  // Steam descriptions are BBCode, and publishers bold the label -- so the
  // tags come out first and the pattern below can stay simple. Trying to make
  // the pattern tolerate them instead just made it eat the start of the id.
  const plain = description.replace(/\[\/?[^\]\n]{1,40}\]/g, ' ');

  const found: string[] = [];
  // The colon is required: "mod id" on its own appears in plenty of prose.
  for (const match of plain.matchAll(/mod\s*ids?\s*:\s*([A-Za-z0-9._-]{2,64})/gi)) {
    const id = match[1];
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

function toItem(raw: SteamDetails): WorkshopItem {
  const size = Number(raw.file_size);
  const description = raw.description ?? '';
  return {
    id: raw.publishedfileid,
    title: raw.title?.trim() || `Workshop item ${raw.publishedfileid}`,
    authorId: raw.creator ?? '',
    authorUrl: raw.creator ? `${PROFILE_URL}${raw.creator}` : '',
    url: `${ITEM_URL}${raw.publishedfileid}`,
    appId: raw.consumer_app_id ?? 0,
    description,
    previewUrl: raw.preview_url || null,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    updatedAt: raw.time_updated ? new Date(raw.time_updated * 1000).toISOString() : null,
    subscriptions: typeof raw.subscriptions === 'number' ? raw.subscriptions : null,
    banned: raw.banned === 1,
    banReason: raw.ban_reason?.trim() || null,
    declaredModIds: scrapeModIds(description),
  };
}

/**
 * Looks up Workshop items by id.
 *
 * One request for the lot: the endpoint is a batch, and a Mods tab listing
 * twenty declared items should not make twenty round trips. Ids Steam does not
 * know are simply absent from the result, so the caller can tell the
 * difference between "gone" and "the whole call failed".
 */
export async function lookupWorkshopItems(ids: string[]): Promise<WorkshopItem[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];

  // This endpoint takes form-encoded input and rejects JSON, unlike the rest
  // of the Steam API.
  const body = new URLSearchParams({ itemcount: String(wanted.length) });
  wanted.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));

  let response: Response;
  try {
    response = await fetch(DETAILS, {
      method: 'POST',
      body,
      headers: { 'user-agent': 'GameKeepr' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ModSourceError(
      `Could not reach the Steam Workshop: ${(err as Error).message}`,
      'unreachable',
    );
  }
  if (!response.ok) {
    throw new ModSourceError(`The Steam Workshop answered ${response.status}.`, 'bad-response');
  }

  const payload = (await response.json()) as {
    response?: { publishedfiledetails?: SteamDetails[] };
  };
  const details = payload.response?.publishedfiledetails ?? [];
  // result 1 is success; anything else is Steam saying it has no such item.
  return details.filter((d) => d.result === 1 && d.publishedfileid).map(toItem);
}

/** Looks up one item, and says so plainly when Steam has never heard of it. */
export async function lookupWorkshopItem(reference: string): Promise<WorkshopItem> {
  const id = parseWorkshopReference(reference);
  const [item] = await lookupWorkshopItems([id]);
  if (!item) {
    throw new ModSourceError(
      `The Steam Workshop has no item ${id}. It may have been removed, or the link may point somewhere else.`,
      'not-found',
    );
  }
  return item;
}

export interface WorkshopVerdict {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

/**
 * Whether this item may be declared on this server.
 *
 * The one check worth having and the one the Workshop actually supports: an
 * item is published against a single game, so an ARK mod on a Conan server is
 * a fact rather than a guess. Everything softer is a warning, because the
 * portal never sees this mod's code and should not imply that it has.
 */
export function judgeWorkshopItem(
  item: WorkshopItem,
  game: { label: string; steamAppId?: number },
): WorkshopVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (item.banned) {
    reasons.push(
      item.banReason
        ? `Steam has removed this item (${item.banReason}), so the server cannot download it.`
        : 'Steam has removed this item, so the server cannot download it.',
    );
  }

  if (game.steamAppId && item.appId && item.appId !== game.steamAppId) {
    reasons.push(
      `This was published for Steam app ${item.appId}, not for ${game.label}. It would never load.`,
    );
  } else if (!game.steamAppId) {
    warnings.push(
      `The portal does not know ${game.label}’s Steam id, so it cannot check that this mod is for the right game.`,
    );
  }

  if (item.subscriptions !== null && item.subscriptions < 100) {
    warnings.push(
      `Only ${item.subscriptions} people subscribe to this. That is not a fault, but few others have run it.`,
    );
  }

  if (item.updatedAt) {
    const years = (Date.now() - Date.parse(item.updatedAt)) / (365 * 24 * 3600 * 1000);
    if (years >= 2) {
      warnings.push(
        `Last updated ${Math.floor(years)} years ago, which often means it predates the current game version.`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons, warnings };
}
