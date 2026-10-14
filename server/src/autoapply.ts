import type { ServerConfig } from './config.js';
import type { DockerClient } from './docker/client.js';
import type { GameSettings } from './gamesettings.js';
import { GameSettingsError, type JoinKey } from './gamesettings.js';
import { gameByQueryType } from './games.js';

/**
 * The deploy-watch's one automatic config write.
 *
 * The Joining card promises "set it here and it is ready the moment the
 * server is" — which was only true for images that read the env variables
 * GameKeepr sets. An image that ignores them (Nodiaque's Enshrouded, which
 * downloads a template config with publicly-known passwords) came up wearing
 * someone else's name and someone else's locks. This closes that gap at the
 * only honest moment: after the first boot, when the game's own config file
 * certainly exists, the typed values go into that file — through the same
 * prepare/commit path the Settings tab uses, backup included — and a changed
 * file earns exactly one restart.
 *
 * What it deliberately does not do: touch a file that already carries the
 * values (the image read its env; restarting would be churn), edit a game the
 * registry has no configFile for, or fight an image that regenerates the file
 * from env on every boot (envAuthoritative — there the env GameKeepr already
 * set is the file's own source).
 */
export function createJoinApplier(deps: {
  dockerClient: DockerClient;
  gameSettings: GameSettings;
  log: (message: string) => void;
}) {
  const { dockerClient, gameSettings, log } = deps;

  return async function applyJoinSettings(
    server: ServerConfig,
    values: Partial<Record<JoinKey, string>>,
  ): Promise<{ result: 'applied' | 'unchanged' | 'skipped'; detail: string }> {
    const configFile = gameByQueryType(server.query?.type)?.configFile;
    if (!configFile) {
      return { result: 'skipped', detail: 'this game has no described configuration file' };
    }
    if (configFile.envAuthoritative) {
      return {
        result: 'skipped',
        detail: 'this image regenerates the file from env, which already carries the values',
      };
    }

    let prepared;
    try {
      prepared = await gameSettings.prepare(server, values);
    } catch (err) {
      const detail =
        err instanceof GameSettingsError ? err.message : `could not prepare the edit: ${(err as Error).message}`;
      log(`join-apply ${server.id}: skipped — ${detail}`);
      return { result: 'skipped', detail };
    }
    if (prepared.applied.length === 0) {
      return { result: 'skipped', detail: 'none of the typed settings map onto this file' };
    }
    if (!prepared.changed) {
      log(`join-apply ${server.id}: ${prepared.file} already carries the typed values`);
      return { result: 'unchanged', detail: 'the file already carries the typed values' };
    }

    /*
     * Stop before writing: games may rewrite their config on shutdown, which
     * would overwrite the edit. Same order, same raw calls as the Settings
     * tab's save. The start lives in finally — a server left stopped because
     * a write failed would be worse than the wrong name.
     */
    const container = dockerClient.docker.getContainer(server.container);
    await container.stop({ t: 30 }).catch((err: { statusCode?: number }) => {
      if (err.statusCode !== 304) throw err;
    });
    try {
      await gameSettings.commit(server, prepared.file, prepared.text);
    } finally {
      await container.start().catch(() => undefined);
      dockerClient.invalidate(server);
    }
    log(
      `join-apply ${server.id}: wrote ${prepared.applied.join(', ')} into ${prepared.file} and restarted once`,
    );
    return {
      result: 'applied',
      detail: `wrote ${prepared.applied.join(', ')} into the game's config file`,
    };
  };
}
