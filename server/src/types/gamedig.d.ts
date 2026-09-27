/**
 * GameDig 5.x ships no type declarations. This describes only the surface we
 * use, mirroring lib/Results.js and lib/gamedig.js in the installed package.
 */
declare module 'gamedig' {
  export interface GameDigPlayer {
    name: string;
    raw: Record<string, unknown>;
  }

  export interface GameDigResult {
    name: string;
    map: string;
    password: boolean;
    raw: Record<string, unknown>;
    version: string;
    maxplayers: number;
    numplayers: number;
    players: GameDigPlayer[];
    bots: GameDigPlayer[];
    queryPort: number;
  }

  export interface GameDigOptions {
    /** A GameDig game id, e.g. "valheim", "palworld", "minecraft". */
    type: string;
    host: string;
    port?: number;
    socketTimeout?: number;
    attemptTimeout?: number;
    maxRetries?: number;
    givenPortOnly?: boolean;
    ipFamily?: 0 | 4 | 6;
    debug?: boolean;
  }

  export class GameDig {
    constructor(options?: Record<string, unknown>);
    query(options: GameDigOptions): Promise<GameDigResult>;
    static query(options: GameDigOptions): Promise<GameDigResult>;
  }

  export const games: Record<string, unknown>;
}
