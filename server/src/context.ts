import type { Env } from './config.js';
import type { ServerRegistry } from './registry.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import type { ActionRunner } from './docker/actions.js';
import type { DeployWatcher } from './deployverify.js';
import type { GameQuery } from './query/gamedig.js';
import type { Cooldown } from './cooldown.js';
import type { ArtworkStore } from './artwork.js';
import type { Catalog } from './catalog.js';
import type { Deployer } from './deploy.js';
import type { MetricsCollector } from './metrics.js';
import type { SettingsManager } from './settings.js';
import type { GameSettings } from './gamesettings.js';
import type { createFileBrowser } from './files.js';
import type { HealthReporter } from './health.js';
import type { ModInstaller } from './mods/install.js';
import type { WorkshopDeclarations } from './mods/declare.js';
import type { Scheduler } from './schedule.js';
import type { BackupService } from './backup.js';
import type { SteamCatalog } from './steam/catalog.js';
import type { GsltService } from './steam/gslt.js';
import type { TournamentStore } from './tournaments/store.js';
import type { MatchOrchestrator } from './tournaments/orchestrator.js';
import type { Notifier } from './notify.js';
import type { Sessions } from './auth/session.js';
import type { SetupGuard } from './auth/setup.js';
import type { LoginThrottle } from './auth/ratelimit.js';
import type { Guard } from './auth/guard.js';

export interface AppContext {
  env: Env;
  /**
    * The security boundary. Turns a client-supplied id into a known server or
    * undefined -- no other path may reach a container name.
    */
  registry: ServerRegistry;
  db: Db;
  docker: DockerClient;
  actions: ActionRunner;
  /** Follows each deploy's first boot until the game proves itself. */
  deployWatch: DeployWatcher;
  gameQuery: GameQuery;
  cooldown: Cooldown;
  artwork: ArtworkStore;
  catalog: Catalog;
  deployer: Deployer;
  metrics: MetricsCollector;
  settings: SettingsManager;
  /** The game's own config file: found, read and edited in place. */
  gameSettings: GameSettings;
  files: ReturnType<typeof createFileBrowser>;
  /** Tells someone when something went wrong. */
  notify: Notifier;
  /** Downloads, inspects and installs game server mods. */
  mods: ModInstaller;
  /** Steam Workshop mods, which are declared in config rather than installed. */
  workshop: WorkshopDeclarations;
  /** Actions that run themselves at a set time. */
  scheduler: Scheduler;
  /** World backups: the small irreplaceable part, not the reinstallable rest. */
  backups: BackupService;
  /** Which dedicated servers Steam carries, and the key that unlocks the full list. */
  steam: SteamCatalog;
  /** Mints and retires Steam game server login tokens for match servers. */
  gslt: GsltService;
  /** Tournaments: teams, entries, brackets and their matches. */
  tournaments: TournamentStore;
  /** Builds, briefs and retires the server behind each match. */
  matches: MatchOrchestrator;
  /** Read-only status of every connection the portal depends on. */
  health: HealthReporter;
  sessions: Sessions;
  setup: SetupGuard;
  throttle: LoginThrottle;
  guard: Guard;
}
