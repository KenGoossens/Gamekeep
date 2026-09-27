/**
 * A minimal Source A2S responder -- enough for GameDig to parse as a real game
 * server. Lets you exercise player counts and the "game is responding" half of
 * a restart without a real game server.
 *
 *   node scripts/fake-game-server.mjs [queryPort] [players] [name]
 *   node scripts/fake-game-server.mjs 2457 3 "Test Valheim"
 *
 * Then point a server's query block at it. Note GameDig applies each game's own
 * query offset, so for type "valheim" you configure the GAME port (2456) and it
 * queries 2457 -- the port this script binds.
 */
import dgram from 'node:dgram';

const PORT = Number(process.argv[2] || 2457);
const PLAYERS = Number(process.argv[3] || 3);
const NAME = process.argv[4] || 'Fake Valheim';
const MAX = 10;

const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

function infoResponse() {
  const appid = Buffer.alloc(2);
  appid.writeUInt16LE(892970 & 0xffff); // A2S appid field is only 16 bits
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), // 'I' + protocol
    cstr(NAME),
    cstr('Midgard'),
    cstr('valheim'),
    cstr('Valheim'),
    appid,
    Buffer.from([PLAYERS, MAX, 0, 0x64, 0x6c, 0, 0]), // players, max, bots, dedicated, linux, public, no VAC
    cstr('0.220.3'),
  ]);
}

function playersResponse() {
  const parts = [Buffer.from([0xff, 0xff, 0xff, 0xff, 0x44, PLAYERS])];
  for (let i = 0; i < PLAYERS; i++) {
    const stats = Buffer.alloc(8);
    stats.writeInt32LE(0, 0);
    stats.writeFloatLE(120 + i, 4);
    parts.push(Buffer.from([i]), cstr(`Viking${i + 1}`), stats);
  }
  return Buffer.concat(parts);
}

function rulesResponse() {
  const count = Buffer.alloc(2);
  count.writeUInt16LE(1);
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x45]),
    count,
    cstr('world'),
    cstr('Midgard'),
  ]);
}

const socket = dgram.createSocket('udp4');
socket.on('message', (msg, from) => {
  const reply =
    msg[4] === 0x54 ? infoResponse() : msg[4] === 0x55 ? playersResponse() : msg[4] === 0x56 ? rulesResponse() : null;
  if (reply) socket.send(reply, from.port, from.address);
});
socket.bind(PORT, () => {
  console.log(`Fake game server on UDP ${PORT} -- "${NAME}", ${PLAYERS}/${MAX} players.`);
  console.log('Ctrl+C to stop.');
});
