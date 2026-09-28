import type { Env } from './config.js';
import type { ServerRegistry } from './registry.js';
import type { Db } from './db.js';
import type { DockerClient } from './docker/client.js';
import type { ActionRunner } from './docker/actions.js';
import type { GameQuery } from './query/gamedig.js';
import type { Cooldown } from './cooldown.js';
import type { ArtworkStore } from './artwork.js';
import type { Catalog } from './catalog.js';
import type { Deployer } from './deploy.js';
import type { MetricsCollector } from './metrics.js';
import type { SettingsManager } from './settings.js';
import type { createFileBrowser } from './files.js';
import type { HealthReporter } from './health.js';
import type { ModInstaller } from './mods/install.js';
import type { WorkshopDeclarations } from './mods/declare.js';
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
  gameQuery: GameQuery;
  cooldown: Cooldown;
  artwork: ArtworkStore;
  catalog: Catalog;
  deployer: Deployer;
  metrics: MetricsCollector;
  settings: SettingsManager;
  files: ReturnType<typeof createFileBrowser>;
  /** Tells someone when something went wrong. */
  notify: Notifier;
  /** Downloads, inspects and installs game server mods. */
  mods: ModInstaller;
  /** Steam Workshop mods, which are declared in config rather than installed. */
  workshop: WorkshopDeclarations;
  /** Read-only status of every connection the portal depends on. */
  health: HealthReporter;
  sessions: Sessions;
  setup: SetupGuard;
  throttle: LoginThrottle;
  guard: Guard;
}
