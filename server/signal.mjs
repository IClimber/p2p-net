// Сервер сигналізації p2p-net (клієнт — v1/net.js): лише знайомить гравців кімнати і пересилає опис WebRTC-з'єднань.
// Сама гра йде напряму між браузерами (DataChannel), через сервер вона не проходить.
//
// Протокол двійковий: перший байт — тип, рядки — UTF-8 з довжиною (varint LEB128), списки — кількість (varint) і елементи.
// Клієнт → сервер:
//   1 join    [версія протоколу u8][гра][кімната][id]   — id генерує клієнт на кожне завантаження сторінки
//   2 signal  [кому][дані…]                              — offer/answer/ICE для іншого гравця; дані сервер не розбирає
// Сервер → клієнт:
//   1 welcome [[id]][[[url] username credential]]        — хто вже в кімнаті + тимчасові облікові дані TURN
//   2 joined  [id] / 3 left [id]                          — хтось зайшов (або перепідключився) / вийшов
//   4 signal  [від кого][дані…]
//   5 full                                                — кімната заповнена
// Закриття: 4001 некоректний join, 4002 кімната заповнена, 4003 замінено новим з'єднанням з тим самим id,
// 4005 інша версія протоколу (сторінку треба оновити), 4008 перевищено ліміт повідомлень, 4029 забагато з'єднань з IP.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Версії протоколу, які приймає сервер. При несумісній зміні нова версія додається сюди, а попередня
// лишається, поки нею користуються ігри (кожна гра переходить на новий net.js у свій час).
const PROTOCOLS = new Set([2]);
const GAME_RE = /^[a-z0-9-]{1,32}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9]{8,32}$/;
const IN = { join: 1, signal: 2 };
const OUT = { welcome: 1, joined: 2, left: 3, signal: 4, full: 5 };

// ---------- Двійковий формат ----------
function varint(v) {
  const out = [];
  while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); }
  out.push(v);
  return Buffer.from(out);
}
// Рядок — з довжиною, масив — список (кількість і елементи), Buffer — як є
function message(type, ...parts) {
  const bufs = [Buffer.from([type])];
  const add = (x) => {
    if (Buffer.isBuffer(x)) bufs.push(x);
    else if (Array.isArray(x)) { bufs.push(varint(x.length)); x.forEach(add); }
    else if (typeof x === 'string') { const b = Buffer.from(x, 'utf8'); bufs.push(varint(b.length), b); }
  };
  parts.forEach(add);
  return Buffer.concat(bufs);
}
function reader(buf) {
  let p = 0;
  const need = (k) => { if (p + k > buf.length) throw new RangeError('short'); };
  const r = {
    u8: () => { need(1); return buf[p++]; },
    uv: () => {
      let v = 0, m = 1;
      for (;;) {
        const b = r.u8();
        v += (b & 127) * m;
        if (b < 128) return v;
        m *= 128;
        if (m > 2 ** 35) throw new RangeError('varint');
      }
    },
    str: () => { const k = r.uv(); need(k); const s = buf.toString('utf8', p, p + k); p += k; return s; },
    rest: () => { const b = buf.subarray(p); p = buf.length; return b; },
  };
  return r;
}

export function createSignalServer({
  maxRoom = 16,                 // гравців у кімнаті
  maxPerIp = 20,                // одночасних з'єднань з однієї IP
  rate = 30, burst = 300,       // повідомлень/с і запас (ICE-кандидати приходять пачками)
  heartbeatMs = 15000,          // ping; хто не відповів до наступного — від'єднується
  turnSecret = null,
  turnUrls = [],
  turnTtl = 24 * 3600,
  log = () => {},
} = {}) {
  const rooms = new Map();      // roomId -> Map(id -> client)
  const perIp = new Map();

  const send = (c, msg) => { try { c.ws.send(msg); } catch {} };
  const broadcast = (room, msg, except) => {
    for (const c of room.values()) if (c !== except) send(c, msg);
  };

  // Облікові дані TURN за схемою TURN REST API (coturn use-auth-secret), як у turn.php
  function turnCreds() {
    if (!turnSecret || !turnUrls.length) return [];
    const username = `${Math.floor(Date.now() / 1000) + turnTtl}:${randomBytes(8).toString('hex')}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    return [{ urls: turnUrls, username, credential }];
  }

  function leave(c) {
    if (!c.room) return;
    const room = rooms.get(c.room);
    if (room && room.get(c.id) === c) {
      room.delete(c.id);
      broadcast(room, message(OUT.left, c.id));
      if (!room.size) rooms.delete(c.room);
    }
    c.room = null;
  }

  function onMessage(c, raw, isBinary) {
    const now = Date.now();
    c.tokens = Math.min(burst, c.tokens + (now - c.tokensAt) / 1000 * rate);
    c.tokensAt = now;
    if (--c.tokens < 0) { log('rate limit', c.ip); return c.ws.close(4008, 'rate'); }
    if (!isBinary) return c.ws.close(4005, 'version');          // старий текстовий (JSON) клієнт
    const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    const r = reader(buf);
    try {
      const type = r.u8();
      if (type === IN.join) {
        if (!PROTOCOLS.has(r.u8())) return c.ws.close(4005, 'version');
        const game = r.str(), roomId = r.str(), id = r.str();
        if (c.room || !GAME_RE.test(game) || !ROOM_RE.test(roomId) || !ID_RE.test(id)) return c.ws.close(4001, 'bad join');
        const key = `${game}/${roomId}`;                         // у кожної гри свої кімнати
        let room = rooms.get(key);
        if (!room) rooms.set(key, room = new Map());
        const old = room.get(id);
        if (!old && room.size >= maxRoom) { send(c, message(OUT.full)); return c.ws.close(4002, 'full'); }
        if (old) { old.room = null; room.delete(id); try { old.ws.close(4003, 'replaced'); } catch {} }  // перепідключення з тим самим id
        c.room = key;
        c.id = id;
        const ice = turnCreds();
        send(c, message(OUT.welcome, [...room.keys()], varint(ice.length), ...ice.flatMap(s => [s.urls, s.username, s.credential])));
        broadcast(room, message(OUT.joined, id));
        room.set(id, c);
      } else if (type === IN.signal) {
        const toId = r.str(), d = r.rest();
        const room = c.room && rooms.get(c.room);
        const to = room && room.get(toId);
        if (to && to !== c && d.length) send(to, message(OUT.signal, c.id, d));
      }
    } catch { /* обрізане повідомлення */ }
  }

  function handleConnection(ws, { ip = '?' } = {}) {
    const n = perIp.get(ip) || 0;
    if (n >= maxPerIp) { try { ws.close(4029, 'too many'); } catch {} return; }
    perIp.set(ip, n + 1);
    const c = { ws, ip, id: null, room: null, alive: true, tokens: burst, tokensAt: Date.now() };
    ws.on('message', (raw, isBinary) => onMessage(c, raw, isBinary));
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => {
      leave(c);
      const k = (perIp.get(ip) || 1) - 1;
      if (k) perIp.set(ip, k); else perIp.delete(ip);
      clients.delete(c);
    });
    ws.on('error', () => {});
    clients.add(c);
  }

  const clients = new Set();
  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch {} continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, heartbeatMs);

  return { handleConnection, rooms, stop: () => clearInterval(hb) };
}

// ---------- Запуск як служба ----------
// Змінні середовища: P2P_HOST, P2P_PORT, P2P_ORIGINS (через кому; '*' — будь-який), P2P_TURN_URLS (через кому),
// P2P_TURN_SECRET_FILE (за замовчуванням — облікові дані systemd LoadCredential=turn-secret:…).
async function main() {
  const env = process.env;
  const require = createRequire(import.meta.url);
  const { WebSocketServer } = require('ws');             // пакет node-ws з apt (або npm ws)
  const list = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  const secretFile = env.P2P_TURN_SECRET_FILE || (env.CREDENTIALS_DIRECTORY ? `${env.CREDENTIALS_DIRECTORY}/turn-secret` : '');
  let turnSecret = null;
  try { turnSecret = secretFile ? readFileSync(secretFile, 'utf8').trim() || null : null; }
  catch (e) { console.error('TURN-секрет недоступний, працюємо без TURN:', e.message); }
  const origins = list(env.P2P_ORIGINS);
  if (!origins.length) console.error('P2P_ORIGINS не задано: жоден браузер не під\'єднається');
  const server = createSignalServer({
    turnSecret,
    turnUrls: list(env.P2P_TURN_URLS),
    log: (...a) => console.log(...a),
  });
  const host = env.P2P_HOST || '127.0.0.1', port = Number(env.P2P_PORT || 8090);
  const wss = new WebSocketServer({
    host,
    port,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
    verifyClient: ({ origin }) => origins.includes('*') || origins.includes(origin),
  });
  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    server.handleConnection(ws, { ip });
  });
  wss.on('listening', () => console.log(`p2p-signal: ${host}:${port}, origins ${origins.join(' ')}, TURN ${turnSecret ? 'є' : 'немає'}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
