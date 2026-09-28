/**
 * What Gamekeep knows about a game, in one place.
 *
 * This used to be scattered: the query type came from servers.json by hand,
 * and the mod layout was a second table keyed by the same string. The result
 * was that a server deployed through the portal got neither -- no player
 * count, and a mods tab that said the game was unsupported -- because nothing
 * ever wrote a game type for it. One registry, consulted at deploy time and by
 * the mod installer, keeps those answers from drifting apart.
 */

import { safeSegment } from './paths.js';

export interface ModLayout {
  /** The repository that serves this game's mods. */
  source: string;
  /**
   * Where a mod goes, relative to the server's data root. The callback takes
   * the mod's id so each one gets its own directory.
   */
  directory: (modId: string) => string;
  /**
   * 'extract' unpacks the archive; 'file' drops the downloaded artefact in as
   * one file, which is what a Minecraft .jar or a Factorio .zip needs -- both
   * are archives the game reads itself, and unpacking them breaks them.
   */
  install: 'extract' | 'file';
  /** Paths proving the mod loader is present, relative to the data root. */
  loaderMarkers: string[];
  /** Extensions a mod for this game may legitimately contain. */
  allowedExtensions: string[];
  /** Thunderstore community slug, for the games that use one. */
  community?: string;
}

export interface GameProfile {
  key: string;
  label: string;
  /** GameDig's id for this game, used for the player count. */
  query: string;
  /**
   * How long this game may take to answer after a restart, in seconds.
   *
   * A ceiling, not a wait: the verifier polls every two seconds and returns
   * the moment the game replies. Set too low it gives up on a healthy server
   * that is still loading its world, which is reported as unconfirmed and
   * looks like a fault. These are measured values from real servers rather
   * than one number applied to every game.
   */
  startupSeconds?: number;
  /**
   * Other ids the same game is known by. GameDig accepts several spellings
   * per game and a hand-written servers.json may use any of them, so a
   * registry that only knew the canonical one would fail to recognise servers
   * that have been working for months.
   */
  aliases?: string[];
  /**
   * Matched against a catalogue app's name and image. Order matters: the first
   * profile that matches wins, so narrow patterns are listed before broad ones.
   */
  match: RegExp[];
  mods?: ModLayout;
  /**
   * Said plainly when a game has mods but no API worth automating, so the UI
   * can explain rather than just refuse.
   */
  modsUnavailable?: string;
}

/** Unreal Engine ships these beside every packaged plugin. */
const UNREAL = ['.pak', '.sig', '.ucas', '.utoc', '.so', '.dll', '.json', '.uplugin',
  '.txt', '.md', '.png', '.jpg', '.cfg', '.ini', '(none)',
  '.sym', '.debug', '.modules', '.uasset', '.umap', '.uexp', '.ubulk', '.res'];

/** A BepInEx plugin is .NET, plus whatever assets it carries. */
const BEPINEX = ['.dll', '.json', '.txt', '.md', '.png', '.jpg', '.cfg', '.xml',
  '.yml', '.yaml', '.assets', '.bundle', '.manifest', '(none)'];

/**
 * A Thunderstore community, of which there are many and they behave
 * identically -- only the slug and the plugin directory differ.
 */
function thunderstore(community: string, pluginDir = 'BepInEx/plugins'): ModLayout {
  return {
    source: 'thunderstore',
    community,
    directory: (modId) => `${pluginDir}/${safeSegment(modId, 'mod name')}`,
    install: 'extract',
    loaderMarkers: ['BepInEx/core', '.doorstop_version'],
    allowedExtensions: BEPINEX,
  };
}

export const GAMES: GameProfile[] = [
  {
    key: 'valheim',
    label: 'Valheim',
    query: 'valheim',
    startupSeconds: 300,
    match: [/valheim/i],
    mods: thunderstore('valheim'),
  },
  {
    key: 'satisfactory',
    label: 'Satisfactory',
    query: 'satisfactory',
    // The slowest of the four measured here: a large factory takes a while.
    startupSeconds: 420,
    match: [/satisfactory/i],
    mods: {
      source: 'ficsit',
      directory: (modId) => `FactoryGame/Mods/${safeSegment(modId, 'mod name')}`,
      install: 'extract',
      loaderMarkers: ['FactoryGame/Mods/SML'],
      allowedExtensions: UNREAL,
    },
  },
  {
    key: 'minecraft-bedrock',
    label: 'Minecraft (Bedrock)',
    query: 'minecraftbe',
    startupSeconds: 240,
    aliases: ['mbe', 'mcbe', 'minecraftped', 'mcpe', 'bedrock'],
    // Listed before the Java pattern: "minecraftbedrockserver" contains both.
    match: [/bedrock/i, /minecraftbe/i],
    modsUnavailable:
      'Bedrock add-ons come as .mcpack or .mcaddon files and there is no open repository to fetch them from — the Marketplace is closed. Add them by hand from the Files tab.',
  },
  {
    key: 'minecraft',
    label: 'Minecraft (Java)',
    query: 'minecraft',
    match: [/minecraft/i, /papermc/i, /spigot/i, /forge/i, /fabric/i],
    mods: {
      source: 'modrinth',
      // A Minecraft mod is a .jar the server loads directly; unpacking it
      // would simply destroy it.
      directory: () => 'mods',
      install: 'file',
      loaderMarkers: ['mods', 'libraries'],
      allowedExtensions: ['.jar'],
    },
  },
  {
    key: 'vrising',
    label: 'V Rising',
    query: 'vrising',
    match: [/v[\s_-]?rising/i],
    mods: thunderstore('v-rising'),
  },
  {
    key: 'lethalcompany',
    label: 'Lethal Company',
    query: 'lethalcompany',
    match: [/lethal[\s_-]?company/i],
    mods: thunderstore('lethal-company'),
  },
  {
    key: 'riskofrain2',
    label: 'Risk of Rain 2',
    query: 'riskofrain2',
    match: [/risk[\s_-]?of[\s_-]?rain/i],
    mods: thunderstore('riskofrain2'),
  },
  {
    key: 'enshrouded',
    label: 'Enshrouded',
    query: 'enshrouded',
    startupSeconds: 360,
    match: [/enshrouded/i],
    modsUnavailable: 'Enshrouded has no mod support, so there is nothing to install.',
  },
  {
    key: 'palworld',
    label: 'Palworld',
    query: 'palworld',
    match: [/palworld/i],
    modsUnavailable:
      'Palworld mods are distributed by hand rather than through a repository. Add them from the Files tab.',
  },
  {
    key: 'projectzomboid',
    label: 'Project Zomboid',
    query: 'projectzomboid',
    match: [/zomboid/i],
    modsUnavailable:
      'Project Zomboid mods live on the Steam Workshop, which needs a Steam account that owns the game — the server downloads them itself once you list the mod ids in its settings.',
  },
  {
    key: 'arkse',
    label: 'ARK: Survival Evolved',
    query: 'arkse',
    aliases: ['ark', 'arksa', 'asa'],
    match: [/ark[\s_:-]*survival[\s_-]*evolved/i, /\base[\s_-]?docker\b/i],
    modsUnavailable:
      'ARK mods come from the Steam Workshop, which no longer allows anonymous downloads — set the mod ids in the server settings and it fetches them itself.',
  },
  {
    key: 'rust',
    label: 'Rust',
    query: 'rust',
    match: [/\brust\b/i],
    modsUnavailable:
      'Rust plugins need the Oxide/uMod loader, which patches the server binary on update rather than dropping in a file.',
  },
  { key: '7d2d', label: '7 Days to Die', query: '7d2d', match: [/7[\s_-]?days/i] },
  { key: 'terraria', label: 'Terraria', query: 'terraria', match: [/terraria/i] },
  {
    key: 'factorio',
    label: 'Factorio',
    query: 'factorio',
    match: [/factorio/i],
    modsUnavailable:
      'Factorio has an official mod portal API, but downloading from it needs the username and token of an account that owns the game — a credential this portal deliberately does not hold. Add mods from the Files tab.',
  },
  { key: 'conanexiles', label: 'Conan Exiles', query: 'conanexiles', match: [/conan/i] },
  { key: 'spaceengineers', label: 'Space Engineers', query: 'spaceengineers', match: [/space[\s_-]?engineers/i] },
  { key: 'soulmask', label: 'Soulmask', query: 'soulmask', match: [/soulmask/i] },
  { key: 'corekeeper', label: 'Core Keeper', query: 'corekeeper', match: [/core[\s_-]?keeper/i] },
];

/**
 * Works out which game a catalogue entry is. Returns null rather than guessing
 * when nothing matches: a wrong game type produces a player count that is
 * silently always zero, which is worse than none at all.
 */
export function identifyGame(name: string, image: string): GameProfile | null {
  const haystack = `${name} ${image}`;
  return GAMES.find((profile) => profile.match.some((pattern) => pattern.test(haystack))) ?? null;
}

export function gameByQueryType(queryType: string | undefined): GameProfile | null {
  if (!queryType) return null;
  const wanted = queryType.toLowerCase();
  return (
    GAMES.find(
      (g) => g.query === wanted || g.key === wanted || (g.aliases ?? []).includes(wanted),
    ) ?? null
  );
}
