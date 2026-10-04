/**
 * What GameKeepr knows about a game, in one place.
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

/**
 * Where a game keeps the list of Steam Workshop mods it fetches for itself.
 *
 * A second install model, and a genuinely different one. These games are not
 * given a mod as a file: they are given a list of Workshop ids in their own
 * configuration and download the mods through SteamCMD on the next start. So
 * installing one writes a config line, uninstalling removes it, and neither
 * takes effect until the server restarts. The portal never holds the code,
 * which is also why the archive scanners have nothing to look at here.
 */
export interface WorkshopLayout {
  /** The directory holding the config, matched as a suffix of a real path. */
  directory: string;
  /** Which file in that directory carries the declarations. */
  file: RegExp;
  /** The INI section the keys sit under, for the files that have sections. */
  section?: string;
  /** The key listing Workshop ids. */
  itemsKey: string;
  /**
   * A second key listing the publishers' own mod names. Project Zomboid needs
   * both: `WorkshopItems` is what SteamCMD downloads and `Mods` is what the
   * game then loads, and a mod declared in only one of them does nothing.
   */
  modIdsKey?: string;
  separator: string;
  /** Said in the UI, because this model does not behave like a file install. */
  note: string;
}

/**
 * Where a game keeps its own configuration file, and which keys in it are the
 * join settings. The point of describing the FILE rather than more env-var
 * spellings: server.properties is defined by Minecraft and identical under
 * every image, while env names differ per image maintainer — the exact
 * confusion the Valheim SRV_PWD bug grew from.
 *
 * The file is searched for, never assumed (same lesson as WorkshopLayout:
 * images root the game in different places), and it usually exists only after
 * the first boot, which is why the Settings Scan runs after deploy
 * verification rather than before.
 */
export interface GameConfigFile {
  /**
   * How to find the file: a directory suffix plus a name pattern (Project
   * Zomboid names the file after the server), or one exact file name searched
   * anywhere under the game's tree (serverconfig.xml, server.properties).
   */
  locate: { directory: string; file: RegExp } | { fileName: string };
  /**
   * How the file spells a setting: 'keyvalue' is key=value lines (INI without
   * sections, server.properties, servertest.ini); 'xml-properties' is 7DTD's
   * <property name="..." value="..."/> lines.
   */
  format: 'keyvalue' | 'xml-properties';
  /** The file's own key for each join-setting class it supports. */
  keys: Partial<Record<'name' | 'world' | 'password' | 'admin', string>>;
  /**
   * True when the common images for this game regenerate the file from
   * environment variables on every start — editing the file then is lost
   * work, and the scan says so up front instead of letting the re-verify
   * discover it.
   */
  envAuthoritative?: boolean;
}

/**
 * A port a game actually needs, as opposed to one its container happens to
 * publish.
 *
 * These are two different questions and the portal only ever answered the
 * second. Reading a container's published ports tells you what to forward; it
 * cannot tell you what is missing, because a template that forgot a port looks
 * exactly like a game that does not need one. Project Zomboid was deployed
 * with only 16261 because that is all its Unraid template declared, and
 * multiplayer silently did not work: the server was up, the status was green,
 * and nobody could join.
 *
 * Every entry below was looked up against the game's own documentation rather
 * than recalled, and each says what it carries so a firewall rule can be
 * written from it.
 */
export interface GamePort {
  port: number;
  protocol: 'tcp' | 'udp';
  /** What travels over it, in words. */
  purpose: string;
  /**
   * False for ports the game runs perfectly well without -- RCON, a web
   * dashboard, an IPv6 twin. Only required ports are added to a deployment
   * that missed them, and only required ones are reported as a gap. Several of
   * the optional ones are administrative and should never face the internet.
   */
  required: boolean;
}

const udp = (port: number, purpose: string, required = true): GamePort => ({
  port,
  protocol: 'udp',
  purpose,
  required,
});
const tcp = (port: number, purpose: string, required = true): GamePort => ({
  port,
  protocol: 'tcp',
  purpose,
  required,
});

/**
 * What a settings field means, for the ones worth explaining.
 *
 * The Settings tab shows a container's environment variables, and a bare
 * variable name is a poor interface: SERVER_PUBLIC=1 does not say what it
 * does, whether 2 is allowed, or that changing WORLD_NAME abandons the world.
 * A spec gives a variable a label, a sentence of context and a type the
 * portal can hold it to -- the part of Pterodactyl's egg format actually
 * worth having. A spec only applies when the container has that variable, so
 * a wrong image simply shows the plain field instead.
 */
export interface SettingSpec {
  key: string;
  label: string;
  help?: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  min?: number;
  max?: number;
  options?: string[];
  /**
   * Marks the settings a player needs to join -- the server's name, its
   * world, its password -- plus 'admin', the administrator credential some
   * games keep beside the join password. Tagged semantically rather than by
   * key, because every image spells them differently (SERVER_PASS,
   * SERVER_PASSWORD, ...). These are offered at deploy time; name, world and
   * password are shown as the server's connect info afterwards, while 'admin'
   * is operator-only and never appears on the Joining card.
   */
  connect?: 'name' | 'world' | 'password' | 'admin';
}

/** The connect-tagged specs for one game, if it is known at all. */
export function connectSettings(game: GameProfile | null): SettingSpec[] {
  return (game?.settings ?? []).filter((spec) => spec.connect);
}

/**
 * Variables the ich777 images share across games. Merged under every game's
 * own specs and, like all specs, shown only when the variable exists.
 */
export const COMMON_SETTINGS: SettingSpec[] = [
  {
    key: 'VALIDATE',
    label: 'Verify game files on start',
    help: 'SteamCMD re-checks every file, which makes starting noticeably slower. Turn it on when files may be damaged, off for everyday use.',
    type: 'boolean',
  },
  {
    key: 'GAME_PARAMS',
    label: 'Extra start parameters',
    help: 'Passed to the game server verbatim. The game decides what they mean.',
    type: 'text',
  },
];

export interface GameProfile {
  key: string;
  label: string;
  /** GameDig's id for this game, used for the player count. */
  query: string;
  /**
   * The game's Steam app id, used for its store artwork.
   *
   * Notifications carry a banner, and Discord sizes an embed to its contents:
   * one with a picture is full width and one without shrinks to its text, so
   * a feed of them looked ragged. Knowing the id here means every Steam game
   * gets its real capsule art rather than a per-server field nobody fills in.
   */
  steamAppId?: number;
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
  /**
   * The ports this game needs. An empty array is a statement, not a gap: it
   * means the game genuinely needs none, which is true of the ones that route
   * players through Steam's relay.
   */
  ports?: GamePort[];
  /** Settings worth explaining; everything else still shows as a plain field. */
  settings?: SettingSpec[];
  /**
   * Whether team-vs-team matches are a real thing in this game — what makes
   * it offerable in the tournament picker. Deliberately conservative: a
   * survival sandbox can host a wonderful competition evening, but that goes
   * through the tournament form's "other game" field, not through a list
   * that claims Factorio has brackets.
   */
  versus?: boolean;
  /**
   * The known-good headless start line for this game's dedicated server,
   * relative to the install directory. Only for games whose Steam app info
   * lists no Linux launch entry: Steam's own answer wins when it exists, but
   * when Steam shrugs, this is the difference between a prefilled form and
   * "write the start command by hand".
   */
  serverLaunch?: string;
  /**
   * Directory names that hold what cannot be redownloaded: worlds, saves,
   * player data, the server's own config. Suffixes to search for rather than
   * fixed paths, because every container image roots the game somewhere else.
   * They only ever become suggestions the operator confirms -- a wrong one
   * costs a missing suggestion, never a wrong backup.
   */
  saves?: string[];
  mods?: ModLayout;
  /** Set instead of `mods` for the games that fetch their own from Steam. */
  workshop?: WorkshopLayout;
  /** Where the game's own config file lives, for the Settings Scan. */
  configFile?: GameConfigFile;
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
    steamAppId: 892970,
    startupSeconds: 300,
    ports: [
      udp(2456, 'Game traffic'),
      udp(2457, 'Steam query, which is what puts it in the server browser'),
    ],
    saves: ['worlds_local'],
    settings: [
      // Two spellings per field on purpose: lloesche's image says SERVER_NAME
      // and SERVER_PASS, ich777's says SRV_NAME and SRV_PWD. A spec only
      // shows when its variable exists, so both can be listed and whichever
      // image is running answers. Found the hard way: a Valheim server with
      // a password in SRV_PWD read as "no password set".
      { key: 'SERVER_NAME', label: 'Server name', type: 'text', connect: 'name' },
      { key: 'SRV_NAME', label: 'Server name', type: 'text', connect: 'name' },
      {
        key: 'WORLD_NAME',
        label: 'World',
        type: 'text',
        connect: 'world',
        help: 'A different name starts a brand-new world. The old one stays on disk.',
      },
      {
        key: 'SERVER_PASS',
        label: 'Password',
        type: 'text',
        min: 5,
        connect: 'password',
        help: 'Five characters minimum, or the server refuses to boot.',
      },
      {
        key: 'SRV_PWD',
        label: 'Password',
        type: 'text',
        min: 5,
        connect: 'password',
        help: 'Five characters minimum, or the server refuses to boot.',
      },
      { key: 'SERVER_PUBLIC', label: 'Listed in the public server browser', type: 'boolean' },
    ],
    match: [/valheim/i],
    mods: thunderstore('valheim'),
  },
  {
    key: 'satisfactory',
    label: 'Satisfactory',
    query: 'satisfactory',
    steamAppId: 526870,
    // The slowest of the four measured here: a large factory takes a while.
    startupSeconds: 420,
    // Since 1.0 everything runs over 7777, but it needs both protocols
    // there -- a UDP-only forward leaves clients unable to finish joining.
    ports: [udp(7777, 'Game traffic'), tcp(7777, 'Server API and joining')],
    saves: ['FactoryGame/Saved'],
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
    versus: true, // bedwars, duels — the classics of server minigames
    label: 'Minecraft (Bedrock)',
    query: 'minecraftbe',
    startupSeconds: 240,
    aliases: ['mbe', 'mcbe', 'minecraftped', 'mcpe', 'bedrock'],
    // Listed before the Java pattern: "minecraftbedrockserver" contains both.
    ports: [
      udp(19132, 'Game traffic'),
      udp(19133, 'The same thing over IPv6', false),
    ],
    saves: ['worlds'],
    settings: [
      { key: 'SERVER_NAME', label: 'Server name', type: 'text', connect: 'name' },
      {
        key: 'GAMEMODE',
        label: 'Game mode',
        type: 'select',
        options: ['survival', 'creative', 'adventure'],
      },
      {
        key: 'DIFFICULTY',
        label: 'Difficulty',
        type: 'select',
        options: ['peaceful', 'easy', 'normal', 'hard'],
      },
      { key: 'MAX_PLAYERS', label: 'Player limit', type: 'number', min: 1, max: 100 },
      { key: 'ALLOW_CHEATS', label: 'Allow cheats', type: 'boolean' },
      {
        key: 'LEVEL_NAME',
        label: 'World',
        type: 'text',
        connect: 'world',
        help: 'A different name starts a brand-new world. The old one stays on disk.',
      },
    ],
    match: [/bedrock/i, /minecraftbe/i],
    modsUnavailable:
      'Bedrock add-ons come as .mcpack or .mcaddon files and there is no open repository to fetch them from — the Marketplace is closed. Add them by hand from the Files tab.',
  },
  {
    key: 'minecraft',
    versus: true, // duels, bedwars, UHC — tournament formats with long traditions
    label: 'Minecraft (Java)',
    query: 'minecraft',
    // Vanilla answers in under a minute; a Forge or Fabric pack generating
    // chunks for a new world is what needs the rest of this.
    startupSeconds: 480,
    ports: [
      tcp(25565, 'Game traffic, and the ping that shows the player count'),
      udp(25565, 'Query, and only when enable-query is set', false),
      tcp(25575, 'RCON. Never forward this one to the internet', false),
    ],
    saves: ['world', 'world_nether', 'world_the_end'],
    configFile: {
      locate: { fileName: 'server.properties' },
      format: 'keyvalue',
      // motd is what the server list (and the query) shows as the name.
      keys: { name: 'motd', world: 'level-name' },
      // The itzg image — what nearly every Minecraft container is — rewrites
      // server.properties from environment variables on every start.
      envAuthoritative: true,
    },
    settings: [
      { key: 'MOTD', label: 'Message of the day', type: 'text' },
      { key: 'MAX_PLAYERS', label: 'Player limit', type: 'number', min: 1, max: 1000 },
      {
        key: 'DIFFICULTY',
        label: 'Difficulty',
        type: 'select',
        options: ['peaceful', 'easy', 'normal', 'hard'],
      },
      { key: 'PVP', label: 'Players can hurt each other', type: 'boolean' },
      {
        key: 'MEMORY',
        label: 'Java memory',
        type: 'text',
        help: 'For example 4G. More helps modded servers; past the container limit it helps nobody.',
      },
      {
        key: 'VERSION',
        label: 'Minecraft version',
        type: 'text',
        help: 'LATEST follows releases. Pin a number when your mods need one.',
      },
    ],
    // Word-bounded: bare /forge/ claimed "Arma Reforger" and "Citadel:
    // Forged With Fire" for Minecraft the moment a broad list ran through it.
    match: [/minecraft/i, /papermc/i, /spigot/i, /\bforge\b/i, /\bfabric\b/i],
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
    versus: true, // arena PvP duels are an established community format
    label: 'V Rising',
    query: 'vrising',
    steamAppId: 1604030,
    // Runs under Wine, which costs it a minute before the game even starts.
    startupSeconds: 300,
    ports: [
      udp(9876, 'Game traffic'),
      udp(9877, 'Steam query'),
    ],
    saves: ['save-data', 'Saves'],
    match: [/v[\s_-]?rising/i],
    mods: thunderstore('v-rising'),
  },
  {
    key: 'lethalcompany',
    label: 'Lethal Company',
    query: 'lethalcompany',
    steamAppId: 1966720,
    // A small game with no world to load.
    startupSeconds: 180,
    // No dedicated server exists: a host plays the game and the others join
    // through Steam. There is nothing to forward, which is different from
    // nothing being known.
    ports: [],
    match: [/lethal[\s_-]?company/i],
    mods: thunderstore('lethal-company'),
  },
  {
    key: 'riskofrain2',
    label: 'Risk of Rain 2',
    query: 'riskofrain2',
    steamAppId: 632360,
    startupSeconds: 180,
    // Peer-to-peer through Steam, like Lethal Company.
    ports: [],
    match: [/risk[\s_-]?of[\s_-]?rain/i],
    mods: thunderstore('riskofrain2'),
  },
  {
    key: 'enshrouded',
    label: 'Enshrouded',
    query: 'enshrouded',
    steamAppId: 1203620,
    startupSeconds: 360,
    ports: [
      udp(15636, 'Game traffic'),
      udp(15637, 'Steam query'),
    ],
    saves: ['savegame'],
    settings: [
      { key: 'SERVER_NAME', label: 'Server name', type: 'text', connect: 'name' },
      { key: 'SERVER_PASSWORD', label: 'Password', type: 'text', connect: 'password' },
      { key: 'SERVER_SLOT_COUNT', label: 'Player limit', type: 'number', min: 1, max: 16 },
    ],
    match: [/enshrouded/i],
    modsUnavailable: 'Enshrouded has no mod support, so there is nothing to install.',
  },
  {
    key: 'palworld',
    versus: true, // the arena gives it real head-to-head matches
    label: 'Palworld',
    query: 'palworld',
    steamAppId: 1623730,
    // Palworld logs that it is ready a minute or two before it actually binds
    // its port, so the poll has to outlast its own optimism.
    startupSeconds: 360,
    ports: [
      udp(8211, 'Game traffic'),
      udp(27015, 'Steam query, needed only to appear in the community list', false),
      tcp(8212, 'REST admin API, if enabled. Keep it off the internet', false),
    ],
    saves: ['Pal/Saved'],
    settings: [
      { key: 'SERVER_NAME', label: 'Server name', type: 'text', connect: 'name' },
      { key: 'PLAYERS', label: 'Player limit', type: 'number', min: 1, max: 32 },
      { key: 'SERVER_PASSWORD', label: 'Password', type: 'text', connect: 'password' },
      {
        key: 'ADMIN_PASSWORD',
        label: 'Admin password',
        type: 'text',
        connect: 'admin',
        help: 'For in-game admin commands. Operators see it here; it is never shown on the Joining card.',
      },
      { key: 'COMMUNITY', label: 'Listed in the community server browser', type: 'boolean' },
    ],
    match: [/palworld/i],
    modsUnavailable:
      'Palworld mods are distributed by hand rather than through a repository. Add them from the Files tab.',
  },
  {
    key: 'projectzomboid',
    label: 'Project Zomboid',
    query: 'projectzomboid',
    steamAppId: 108600,
    /*
     * Workshop mods are downloaded on the start *after* they are added to the
     * config, and that download finishes before the server answers a query.
     * The default 300s reported three healthy restarts in a row as
     * unconfirmed for exactly this reason.
     */
    startupSeconds: 900,
    /*
     * Both are required and only the first is ever in a template, which is
     * exactly how this server ended up unjoinable: 16261 alone leaves the
     * server visible with no working connection path for players.
     */
    ports: [
      udp(16261, 'Game traffic and Steam discovery'),
      udp(16262, 'The channel players actually connect over'),
    ],
    saves: ['Zomboid/Saves', 'Zomboid/Server', 'Zomboid/db'],
    // Steam's app info lists no Linux launch entry for the dedicated server;
    // this is the script it actually ships.
    serverLaunch: './start-server.sh',
    match: [/zomboid/i],
    configFile: {
      // The same found-not-assumed file the Workshop declarations edit.
      locate: { directory: 'Zomboid/Server', file: /\.ini$/i },
      format: 'keyvalue',
      keys: { name: 'PublicName', password: 'Password' },
    },
    workshop: {
      // The file is named after the server, so it is found rather than
      // assumed: the default is servertest.ini but nothing guarantees it.
      // The other files beside it are .lua, so matching .ini is enough.
      directory: 'Zomboid/Server',
      file: /\.ini$/i,
      itemsKey: 'WorkshopItems',
      modIdsKey: 'Mods',
      separator: ';',
      note: 'Project Zomboid downloads Workshop mods itself on the next start, so this can take several minutes and the mods are not active until then.',
    },
  },
  {
    key: 'arkse',
    label: 'ARK: Survival Evolved',
    query: 'arkse',
    steamAppId: 346110,
    /*
     * The slowest server here by a wide margin: ARK redownloads and extracts
     * its entire Workshop mod list on every start, then loads a large map.
     * Twenty minutes is a ceiling for a first boot with mods, not a typical
     * restart -- the verifier still returns the moment the game answers.
     */
    startupSeconds: 1200,
    aliases: ['ark', 'arksa', 'asa'],
    ports: [
      udp(7777, 'Game traffic'),
      udp(7778, 'Raw socket, which ARK uses alongside the game port'),
      udp(27015, 'Steam query'),
      tcp(27020, 'RCON, if enabled. Keep it off the internet', false),
    ],
    saves: ['ShooterGame/Saved'],
    match: [/ark[\s_:-]*survival[\s_-]*evolved/i, /\base[\s_-]?docker\b/i],
    workshop: {
      directory: 'Config/LinuxServer',
      file: /^GameUserSettings\.ini$/i,
      // Unlike Project Zomboid's flat file, this one has sections and the key
      // means nothing outside its own.
      section: 'ServerSettings',
      itemsKey: 'ActiveMods',
      separator: ',',
      note: 'ARK redownloads its whole Workshop list on every start, so expect a long first boot after changing this.',
    },
  },
  {
    key: 'rust',
    label: 'Rust',
    query: 'rust',
    steamAppId: 252490,
    // A wipe regenerates the map, which is most of this.
    startupSeconds: 900,
    ports: [
      udp(28015, 'Game traffic'),
      udp(28017, 'Server browser queries'),
      tcp(28016, 'RCON. Keep it off the internet', false),
      tcp(28082, 'Rust+ companion app', false),
    ],
    match: [/\brust\b/i],
    modsUnavailable:
      'Rust plugins need the Oxide/uMod loader, which patches the server binary on update rather than dropping in a file.',
  },
  // Generates its world on first boot.
  {
    key: '7d2d',
    label: '7 Days to Die',
    query: '7d2d',
    startupSeconds: 600,
    steamAppId: 251570,
    ports: [
      tcp(26900, 'Game traffic'),
      udp(26900, 'Game traffic'),
      udp(26901, 'Steam query'),
      udp(26902, 'Second game channel'),
      tcp(8080, 'Web dashboard. Keep it off the internet', false),
      tcp(8081, 'Telnet. Keep it off the internet', false),
    ],
    saves: ['Saves'],
    // No Linux launch entry in Steam's app info; the depot ships this script.
    serverLaunch: './startserver.sh -configfile=serverconfig.xml',
    configFile: {
      // The depot ships serverconfig.xml beside the start script; the launch
      // line above names it explicitly.
      locate: { fileName: 'serverconfig.xml' },
      format: 'xml-properties',
      keys: { name: 'ServerName', world: 'GameWorld', password: 'ServerPassword' },
    },
    match: [/7[\s_-]?days/i],
  },
  {
    key: 'terraria',
    versus: true, // PvP arenas are niche but real
    label: 'Terraria',
    query: 'terraria',
    startupSeconds: 180,
    steamAppId: 105600,
    ports: [tcp(7777, 'Game traffic')],
    saves: ['Worlds'],
    match: [/terraria/i],
  },
  {
    key: 'factorio',
    label: 'Factorio',
    query: 'factorio',
    steamAppId: 427520,
    // Genuinely fast, even on a large save.
    startupSeconds: 120,
    // UDP only: forwarding TCP 34197 does nothing at all.
    ports: [udp(34197, 'Game traffic')],
    saves: ['saves'],
    match: [/factorio/i],
    modsUnavailable:
      'Factorio has an official mod portal API, but downloading from it needs the username and token of an account that owns the game — a credential this portal deliberately does not hold. Add mods from the Files tab.',
  },
  // Another Workshop-list game: mods are fetched during start.
  {
    key: 'conanexiles',
    label: 'Conan Exiles',
    query: 'conanexiles',
    startupSeconds: 900,
    steamAppId: 440900,
    ports: [
      udp(7777, 'Game traffic'),
      udp(7778, 'Raw socket'),
      udp(27015, 'Steam query'),
    ],
    saves: ['ConanSandbox/Saved'],
    match: [/conan/i],
  },
  {
    key: 'spaceengineers',
    label: 'Space Engineers',
    query: 'spaceengineers',
    startupSeconds: 420,
    steamAppId: 244850,
    ports: [udp(27016, 'Game traffic')],
    saves: ['Saves'],
    match: [/space[\s_-]?engineers/i],
  },
  {
    key: 'soulmask',
    label: 'Soulmask',
    query: 'soulmask',
    startupSeconds: 420,
    steamAppId: 2646460,
    ports: [
      udp(8777, 'Game traffic'),
      udp(27015, 'Steam query'),
    ],
    saves: ['Saved'],
    match: [/soulmask/i],
  },
  {
    key: 'corekeeper',
    label: 'Core Keeper',
    query: 'corekeeper',
    startupSeconds: 240,
    steamAppId: 1621690,
    /*
     * Nothing by default: it reaches players through Steam's relay, so an
     * outbound connection is all it needs. Setting a port switches it to
     * direct connections, which is the operator's choice and their forward.
     */
    ports: [],
    match: [/core[\s_-]?keeper/i],
  },
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

/**
 * Ports this game needs that the container does not publish.
 *
 * The gap between what a game requires and what its Unraid template happened
 * to declare. Only required ports count: an absent RCON port is a choice, and
 * reporting it would teach people to ignore this.
 *
 * Returns an empty list both when nothing is missing and when the game is not
 * in the registry -- the caller is told which case it is by whether the
 * profile was found, because "I checked and it is fine" and "I have no idea"
 * must not look the same in the UI.
 */
export function missingPorts(
  game: GameProfile | null | undefined,
  published: Iterable<{ port: number; protocol: 'tcp' | 'udp' }>,
): GamePort[] {
  if (!game?.ports?.length) return [];
  const have = new Set<string>();
  for (const p of published) have.add(`${p.port}/${p.protocol}`);
  return game.ports.filter((p) => p.required && !have.has(`${p.port}/${p.protocol}`));
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
