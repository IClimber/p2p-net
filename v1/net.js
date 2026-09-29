// net.js (p2p-net v1) — мережевий шар браузерних P2P-ігор з кімнатами.
// Підключення: import { createNet } from 'https://iclimber.github.io/p2p-net/v1/net.js';
//
// Сервер сигналізації (server/signal.mjs) лише знайомить гравців кімнати і пересилає опис WebRTC-з'єднань;
// сама гра йде напряму між браузерами: mesh, на кожну пару два DataChannel — надійний і ненадійний.
// Модуль бере на себе з'єднання і повтори, ретрансляцію для неповного mesh, вибір хоста, спільний годинник,
// живість гравців, вихід (bye), статистику з'єднань і двійковий формат повідомлень. Логіка гри — у колбеках.
//
//   const net = createNet({
//     url: 'wss://…/ws', game: 'firefighters', room: 'abc',
//     messages: {                                   // повідомлення гри: схема і спосіб доставки
//       pos:   { schema: { x: 'u16', y: 'u16' }, broadcast: true, unreliable: true },
//       douse: { schema: { i: 'u8' } },
//     },
//     hasGame: () => …,                             // чи є в нас гра (такий гравець має перевагу на роль хоста)
//     onMessage(kind, data, from) {},               // дані вже декодовані й перевірені за схемою
//     onPeerOpen(id) {},                            // відкрилося пряме з'єднання: час надіслати новачкові свій стан
//     onPeerGone(id) {},                            // гравець вийшов (bye) або давно замовк — забути його
//     onWelcome(others, again) {},                  // сервер прийняв у кімнату; others — скільки там інших
//     onVisibility(hidden) {},                      // вкладка сховалась/повернулась (до того, як інші про це дізнаються)
//     onWarn(code) {},                              // 'link' | 'full' | 'outdated' | 'version'
//     onChange() {},                                // змінилося те, що показує HUD (гравці, хост, зв'язок)
//   });
//   net.start();
//   net.send(kind, data, to?)  — to: одному гравцю (напряму або через спільного сусіда), інакше всім прямим сусідам
//
// Схема: 'u8' 'u16' 'u32' 'i8' 'i16' 'i32' 'f32' 'f64' 'bool' 'str' 'bytes', [тип] — масив,
// { поле: тип, … } — об'єкт (поля йдуть у порядку оголошення). Цілі при записі округлюються й обрізаються
// до меж типу; при читанні зайві чи відсутні байти, NaN/Infinity, bool не 0/1, битий UTF-8 — відкидають повідомлення.
//
// broadcast — розсилається всім і ретранслюється тим, з ким в автора немає прямого з'єднання.
// unreliable — ненадійний невпорядкований канал (для частого стану, як позиції): втрачене не надсилається
// повторно й не затримує наступне; модуль додає номер і відкидає застаріле, при переповненні каналу не шле.
// Адресні повідомлення (send з to) завжди йдуть надійним каналом.

// ================= Налаштування =================
const PROTOCOL = 2;                  // версія протоколу з сервером сигналізації (див. server/signal.mjs)
const WIRE = 2;                      // версія формату повідомлень між гравцями (входить у хеш версії)
const LIVE_MS = 3000;                // гравця, від якого стільки не було повідомлень, не малюємо і не обираємо хостом
const FORGET_MS = 30000;             // через скільки забуваємо непрямого гравця, що замовк
const RESUME_GAP_MS = 2000;          // пауза таймерів, після якої вважаємо, що сторінку було заморожено
const CONNECT_TIMEOUT_MS = 12000;    // WebRTC-з'єднання не відкрилося за стільки — пробуємо заново
const DISCONNECT_GRACE_MS = 5000;    // стан disconnected довше — з'єднання вважається розірваним
const RETRY_MS = 2000;               // пауза перед повторною спробою з'єднатися з гравцем
const HELLO_EVERY = 5;               // hello раз на стільки секунд
const BACKPRESSURE = 64 * 1024;      // у каналі стільки ненадісланого — ненадійні повідомлення пропускаємо
const MAX_FRAME = 65536;
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const randomId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ID_CHARS[b % 62]).join('');
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9]{8,32}$/.test(v);
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ================= Двійковий формат =================
const utf8e = new TextEncoder(), utf8d = new TextDecoder('utf-8', { fatal: true });
const INT = { u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295], i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647] };
const SIZE = { u8: 1, u16: 2, u32: 4, i8: 1, i16: 2, i32: 4, f32: 4, f64: 8, bool: 1 };
const MAX_ITEMS = 65536;

class Writer {
  constructor() { this.buf = new Uint8Array(128); this.dv = new DataView(this.buf.buffer); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf);
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  uv(v) {                                            // беззнакове ціле змінної довжини (LEB128)
    v = Math.max(0, Math.floor(v));
    while (v >= 128) { this.need(1); this.buf[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.need(1);
    this.buf[this.n++] = v;
  }
  raw(b) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
  num(t, v) {
    v = t === 'bool' ? (v ? 1 : 0) : Number(v);
    if (!Number.isFinite(v)) v = 0;
    const r = INT[t];
    if (r) v = Math.min(r[1], Math.max(r[0], Math.round(v)));
    this.need(SIZE[t]);
    const d = this.dv, p = this.n;
    switch (t) {
      case 'u8': case 'bool': d.setUint8(p, v); break;
      case 'i8': d.setInt8(p, v); break;
      case 'u16': d.setUint16(p, v, true); break;
      case 'i16': d.setInt16(p, v, true); break;
      case 'u32': d.setUint32(p, v, true); break;
      case 'i32': d.setInt32(p, v, true); break;
      case 'f32': d.setFloat32(p, v, true); break;
      case 'f64': d.setFloat64(p, v, true); break;
    }
    this.n += SIZE[t];
  }
  bytes() { return this.buf.slice(0, this.n); }
}

class Reader {
  constructor(b) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.p = 0; }
  left() { return this.b.length - this.p; }
  take(k) {
    if (k > this.left()) throw new RangeError('short');
    const p = this.p;
    this.p += k;
    return p;
  }
  uv() {
    let v = 0, m = 1;
    for (;;) {
      const b = this.b[this.take(1)];
      v += (b & 127) * m;
      if (b < 128) return v;
      m *= 128;
      if (m > 2 ** 35) throw new RangeError('varint');
    }
  }
  num(t) {
    const p = this.take(SIZE[t]), d = this.dv;
    switch (t) {
      case 'u8': return d.getUint8(p);
      case 'i8': return d.getInt8(p);
      case 'u16': return d.getUint16(p, true);
      case 'i16': return d.getInt16(p, true);
      case 'u32': return d.getUint32(p, true);
      case 'i32': return d.getInt32(p, true);
      case 'bool': { const v = d.getUint8(p); if (v > 1) throw new RangeError('bool'); return v === 1; }
      case 'f32': case 'f64': {
        const v = t === 'f32' ? d.getFloat32(p, true) : d.getFloat64(p, true);
        if (!Number.isFinite(v)) throw new RangeError('float');
        return v;
      }
    }
  }
}

function put(w, t, v) {
  if (typeof t === 'string') {
    if (t === 'str') { const b = utf8e.encode(v == null ? '' : String(v)); w.uv(b.length); w.raw(b); }
    else if (t === 'bytes') { const b = v instanceof Uint8Array ? v : new Uint8Array(0); w.uv(b.length); w.raw(b); }
    else w.num(t, v);
  } else if (Array.isArray(t)) {
    const a = Array.isArray(v) ? v : [];
    w.uv(a.length);
    for (const x of a) put(w, t[0], x);
  } else {
    for (const k in t) put(w, t[k], v == null ? undefined : v[k]);
  }
}
function get(r, t) {
  if (typeof t === 'string') {
    if (t === 'str' || t === 'bytes') {
      const k = r.uv(), p = r.take(k);
      return t === 'str' ? utf8d.decode(r.b.subarray(p, p + k)) : r.b.slice(p, p + k);
    }
    return r.num(t);
  }
  if (Array.isArray(t)) {
    const k = r.uv();
    if (k > r.left() || k > MAX_ITEMS) throw new RangeError('array');
    const a = new Array(k);
    for (let i = 0; i < k; i++) a[i] = get(r, t[0]);
    return a;
  }
  const o = {};
  for (const k in t) o[k] = get(r, t[k]);
  return o;
}
function checkSchema(t) {
  if (typeof t === 'string') { if (t !== 'str' && t !== 'bytes' && !SIZE[t]) throw new Error(`net: невідомий тип ${t}`); }
  else if (Array.isArray(t)) { if (t.length !== 1) throw new Error('net: масив має один тип елементів'); checkSchema(t[0]); }
  else if (t && typeof t === 'object') { for (const k in t) checkSchema(t[k]); }
  else throw new Error('net: некоректна схема');
}
export function encode(schema, value) { const w = new Writer(); put(w, schema, value); return w.bytes(); }
export function decode(schema, bytes) {
  const r = new Reader(bytes), v = get(r, schema);
  if (r.left()) throw new RangeError('trailing');
  return v;
}

// Протокол із сервером сигналізації (див. server/signal.mjs)
const TO_SERVER = { join: 1, signal: 2 };
const FROM_SERVER = { welcome: 1, joined: 2, left: 3, signal: 4, full: 5 };
const CLOSE_VERSION = 4005;
const ICE_SCHEMA = [{ urls: ['str'], username: 'str', credential: 'str' }];
// Сигнал між гравцями: t — 0 offer, 1 answer, 2 ICE-кандидат, 3 ask (почни з'єднання заново); n — id спроби
const SIG = { offer: 0, answer: 1, cand: 2, ask: 3 };
const SIGNAL_SCHEMA = { n: 'str', t: 'u8', s: 'str', mid: 'str', idx: 'i32', uf: 'str' };

// ================= Мережа гри =================
export function createNet(opts) {
  const {
    url, game, room, iceServers = STUN, messages = {},
    hasGame = () => false,
    onMessage = () => {}, onPeerOpen = () => {}, onPeerGone = () => {}, onWelcome = () => {},
    onVisibility = () => {}, onWarn = () => {}, onChange = () => {},
  } = opts;

  // Типи повідомлень: службові, далі ігрові. Номер типу — перший байт кадру.
  const INTERNAL = {
    hello: { schema: { v: 'u32', t: 'f64', a: 'bool', g: 'bool', n: ['str'] }, broadcast: true },
    bye: { schema: {}, broadcast: true },
    tq: { schema: { c: 'f64' } },
    clock: { schema: { c: 'f64', ht: 'f64' } },
    fwd: { schema: { k: 'u8', o: 'str', to: 'str', d: 'bytes' } },
  };
  const kinds = [], byName = new Map();
  const addKind = (name, spec, isGame) => {
    if (byName.has(name)) throw new Error(`net: повідомлення ${name} уже є`);
    checkSchema(spec.schema || {});
    const k = { id: kinds.length, name, schema: spec.schema || {}, broadcast: !!spec.broadcast, unreliable: !!spec.unreliable, game: isGame, seq: 0 };
    kinds.push(k);
    byName.set(name, k);
  };
  for (const [name, spec] of Object.entries(INTERNAL)) addKind(name, spec, false);
  for (const [name, spec] of Object.entries(messages)) addKind(name, spec, true);
  if (kinds.length > 256) throw new Error('net: забагато типів повідомлень');
  const FWD = byName.get('fwd');
  // Гравці з іншою версією (інші схеми — інша сторінка в кеші) не розуміють одне одного: їх ігноруємо
  const version = hashStr(JSON.stringify([WIRE, kinds.map(k => [k.name, k.schema, k.broadcast, k.unreliable]), opts.version ?? '']));

  // ---------- Стан ----------
  const selfId = randomId(20);       // новий на кожне завантаження сторінки (після bye старий id ігнорується)
  // Місце в черзі на роль хоста: менше — раніше. Спершу це час входу, потім лише зростає
  // (після приєднання до чужої гри і після повернення з фону стаємо в кінець черги).
  let myStamp = Date.now();
  // peerId -> інший гравець: прямо підключений (direct) або відомий через ретранслятор
  const peers = new Map();
  const gone = new Set();            // хто попрощався (bye): їхні запізнілі повідомлення ігноруємо
  // peerId -> пряме з'єднання { pc, r, u (канали), n (id спроби), open, remote, inCands, outCands, sent, stat }
  const links = new Map();
  let left = false, started = false;

  function getPeer(id) {
    let p = peers.get(id);
    if (!p) {
      p = { t: null, away: false, hasGame: false, ok: null, links: null, direct: false, seen: 0, lastHello: null, seq: new Map() };
      peers.set(id, p);
    }
    return p;
  }
  const isLivePeer = (p, now = performance.now()) => p.ok === true && now - p.seen < LIVE_MS;
  const liveCount = () => {
    const now = performance.now();
    let n = 0;
    for (const p of peers.values()) if (isLivePeer(p, now)) n++;
    return n;
  };
  const directIds = () => [...peers].filter(([, p]) => p.direct).map(([id]) => id);

  // Хост: спершу ті, у кого вже є гра, далі менший штамп, при рівності — менший id.
  // Хто відійшов (вкладка прихована) або мовчить довше LIVE_MS, хостом не стає, поки є інші кандидати.
  function hostId() {
    checkResume();
    const now = performance.now();
    let best = null, bestG = 0, bestT = 0;
    const consider = (id, has, t) => {
      const g = has ? 0 : 1;
      if (best === null || g < bestG || (g === bestG && (t < bestT || (t === bestT && id < best)))) {
        best = id; bestG = g; bestT = t;
      }
    };
    const pick = (strict) => {
      if (!strict || !document.hidden) consider(selfId, !!hasGame(), myStamp);
      for (const [id, p] of peers) {
        if (p.t == null || !isLivePeer(p, now) || (strict && p.away)) continue;
        consider(id, p.hasGame, p.t);
      }
    };
    pick(true);
    if (best === null) pick(false);
    return best;
  }
  const isHost = () => hostId() === selfId;

  // Спільний час (для детермінованих подій, як машини) — годинник хоста. Раз на секунду питаємо хоста (tq з нашим
  // performance.now()), він відповідає своїм sharedNow(): зсув = ht + RTT/2 - Date.now(). З останніх вимірів беремо
  // той, де RTT найменший: у ньому найменше черг і повторів, похибка — лише асиметрія шляху.
  // Новий хост зберігає свій зсув, тому при зміні хоста час не стрибає.
  let clockOffset = 0, clockFrom = null, clockAsked = -1e9;
  const clockSamples = [];
  function askClock(host) {
    clockAsked = performance.now();
    send('tq', { c: clockAsked }, host);
  }
  function sampleClock(d, from) {
    const rtt = performance.now() - d.c;
    if (!(rtt >= 0 && rtt < 10000)) return;
    if (from !== clockFrom) { clockFrom = from; clockSamples.length = 0; }
    clockSamples.push({ rtt, off: d.ht + rtt / 2 - Date.now() });
    if (clockSamples.length > 12) clockSamples.shift();
    let best = clockSamples[0];
    for (const x of clockSamples) if (x.rtt < best.rtt) best = x;
    clockOffset = best.off;
  }
  const sharedNow = () => Date.now() + clockOffset;

  // Стати в кінець черги на роль хоста
  function restamp() {
    let m = myStamp;
    for (const p of peers.values()) if (p.t != null && p.t > m) m = p.t;
    myStamp = m + 1;
    sendHello();
  }
  // Сторінку було заморожено (телефон у фоні): роль хоста могли перейняти, не перебиваємо її.
  // Викликається перед будь-яким надсиланням і вибором хоста, тож заморожений хост не встигне розіслати старий стан.
  let lastBeat = performance.now();
  function checkResume() {
    const now = performance.now(), gap = now - lastBeat;
    lastBeat = now;
    if (gap > RESUME_GAP_MS && started) {
      if (peers.size) restamp();
      wake();
    }
  }

  // ---------- Надсилання ----------
  function frame(k, data) {
    const w = new Writer();
    w.num('u8', k.id);
    if (k.unreliable) w.num('u32', k.seq++);
    put(w, k.schema, data);
    return w.bytes();
  }
  const fwdFrame = (k, origin, to, body) => frame(FWD, { k: k.id, o: origin, to, d: body });
  function sendFrame(id, bytes, unreliable) {
    const L = links.get(id);
    if (!L || !L.open) return;
    const dc = unreliable && L.u.readyState === 'open' ? L.u : L.r;
    if (dc.readyState !== 'open' || (unreliable && dc.bufferedAmount > BACKPRESSURE)) return;
    try { dc.send(bytes); } catch {}
  }
  // Спільний сусід із найменшим id, через якого досяжний гравець без прямого з'єднання
  function viaFor(to) {
    let via = null;
    for (const [id, q] of peers) if (q.direct && q.links && q.links.has(to) && (via === null || id < via)) via = id;
    return via;
  }
  function send(name, data, to) {
    const k = byName.get(name);
    if (!k) throw new Error(`net: невідоме повідомлення ${name}`);
    checkResume();
    const bytes = frame(k, data);
    if (to == null) {
      for (const id of links.keys()) sendFrame(id, bytes, k.unreliable);
    } else if (peers.get(to)?.direct) {
      sendFrame(to, bytes, false);
    } else {                                                     // адресне — через спільного сусіда (один стрибок)
      const via = viaFor(to);
      if (via !== null) sendFrame(via, fwdFrame(k, selfId, to, bytes.subarray(1)), false);
    }
  }
  const sendHello = (to) => send('hello', { v: version, t: myStamp, a: document.hidden, g: !!hasGame(), n: directIds() }, to);

  // Ретрансляція (неповний mesh): отримане напряму від `from` пересилаємо тим своїм сусідам,
  // у кого немає прямого з'єднання з `from`. Пересилає лише один — сусід із найменшим id серед спільних.
  function isRelayFor(from, to) {
    const src = peers.get(from), dst = peers.get(to);
    if (from === to || !src || !src.direct || !src.links || !dst || !dst.direct || !dst.links || dst.links.has(from)) return false;
    for (const z of dst.links) if (z < selfId && z !== from && src.links.has(z)) return false;
    return true;
  }
  function relayOut(k, body, from) {
    let bytes = null;
    for (const [id, p] of peers) {
      if (p.direct && isRelayFor(from, id)) sendFrame(id, bytes ??= fwdFrame(k, from, '', body), k.unreliable);
    }
  }
  // Новому сусідові одразу пересилаємо останні hello тих, з ким у нього немає прямого з'єднання
  function introduceTo(to) {
    const hello = byName.get('hello');
    for (const [id, p] of peers) {
      if (p.lastHello && isRelayFor(id, to)) sendFrame(to, fwdFrame(hello, id, '', p.lastHello), false);
    }
  }

  // ---------- Приймання ----------
  const ON = {
    hello(d, id, p, body) {
      p.t = d.t;
      p.away = d.a;
      p.hasGame = d.g;
      const ok = d.v === version;
      if (!ok && p.ok !== false) onWarn('version');
      p.ok = ok;
      if (p.direct) {
        p.lastHello = body;
        const before = p.links;
        p.links = new Set(d.n.filter(isId).slice(0, 64));
        if (!(before && before.size === p.links.size && [...before].every(z => p.links.has(z)))) introduceTo(id);
      }
      if (clockFrom !== id && id === hostId() && performance.now() - clockAsked > 500) askClock(id);   // новий хост — не чекаємо секунду
      onChange();
    },
    bye(d, id) {
      gone.add(id);
      peers.delete(id);
      const L = links.get(id);
      if (L) dropLink(L, false);                                 // не чекаємо, поки з'єднання відпаде саме
      onPeerGone(id);
      onChange();
    },
    tq(d, id) {
      send('clock', { c: d.c, ht: sharedNow() }, id);
    },
    clock(d, id) {
      if (id === hostId()) sampleClock(d, id);
    },
  };
  function receive(k, body, from, relayed) {
    if (!isId(from) || from === selfId || gone.has(from)) return;
    let d, seq = null;
    try {
      const r = new Reader(body);
      if (k.unreliable) seq = r.num('u32');
      d = get(r, k.schema);
      if (r.left()) return;
    } catch { return; }
    checkResume();
    const p = getPeer(from);
    p.seen = performance.now();
    if (!relayed && k.broadcast) relayOut(k, body, from);
    if (seq !== null) {                                          // дубль або застаріле (невпорядкований канал, ретранслятор)
      if (seq <= (p.seq.get(k.id) ?? -1)) return;
      p.seq.set(k.id, seq);
    }
    if (!k.game) ON[k.name](d, from, p, body);
    else if (p.ok) onMessage(k.name, d, from);
  }
  function onFwd(m, peerId) {
    const k = kinds[m.k];
    if (!k || k === FWD || !isId(m.o)) return;
    if (m.to) {                                                  // адресне: доставити або передати далі (один стрибок)
      if (m.to === selfId) receive(k, m.d, m.o, true);
      else if (m.o === peerId && peers.get(m.to)?.direct) sendFrame(m.to, fwdFrame(k, m.o, m.to, m.d), false);
      return;
    }
    if (peers.get(m.o)?.direct) return;                          // з ним є пряме з'єднання, копія не потрібна
    receive(k, m.d, m.o, true);
  }
  function onData(L, raw) {
    if (links.get(L.id) !== L || !raw || typeof raw.byteLength !== 'number' || !raw.byteLength || raw.byteLength > MAX_FRAME) return;
    const b = new Uint8Array(raw), k = kinds[b[0]];
    if (!k) return;
    if (k !== FWD) return receive(k, b.subarray(1), L.id, false);
    let m;
    try { m = decode(FWD.schema, b.subarray(1)); } catch { return; }
    onFwd(m, L.id);
  }

  function peerOpened(id) {
    if (gone.has(id)) return;
    const p = getPeer(id);
    p.direct = true;
    p.seen = performance.now();
    sendHello();                                                 // список сусідів змінився — усім
    onPeerOpen(id);
    onChange();
  }
  function peerClosed(id) {
    const p = peers.get(id);
    if (p) { p.direct = false; p.links = null; p.lastHello = null; }   // може лишатися досяжним через інших
    sendHello();
    onChange();
  }

  // ---------- WebRTC-з'єднання з гравцями ----------
  // offer завжди робить гравець із меншим id, тож зустрічних offer-ів не буває.
  // Канали домовлені заздалегідь (negotiated): 0 — надійний упорядкований, 1 — ненадійний невпорядкований.
  let ice = iceServers;              // + TURN, облікові дані якого дає сервер у welcome
  let inRoom = new Set();            // хто в кімнаті за даними сервера

  function makeLink(id, n) {
    const pc = new RTCPeerConnection({ iceServers: ice });
    const L = { id, pc, r: null, u: null, n, open: false, remote: false, inCands: [], outCands: [], sent: false, timer: 0, discTimer: 0, stat: null };
    links.set(id, L);
    L.r = pc.createDataChannel('r', { negotiated: true, id: 0 });
    L.u = pc.createDataChannel('u', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    for (const dc of [L.r, L.u]) {
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (e) => onData(L, e.data);
    }
    L.r.onopen = () => {
      if (links.get(id) !== L || L.open) return;
      L.open = true;
      clearTimeout(L.timer);
      peerOpened(id);
    };
    L.r.onclose = () => dropLink(L, true);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (L.sent) sendCandidate(L, e.candidate); else L.outCands.push(e.candidate);   // кандидати — лише після offer/answer
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') dropLink(L, true);
      else if (st === 'disconnected') {
        clearTimeout(L.discTimer);
        L.discTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') dropLink(L, true); }, DISCONNECT_GRACE_MS);
      }
    };
    L.timer = setTimeout(() => { if (!L.open) dropLink(L, true); }, CONNECT_TIMEOUT_MS);
    return L;
  }
  const sendCandidate = (L, c) => signal(L.id, {
    n: L.n, t: SIG.cand, s: c.candidate, mid: c.sdpMid ?? '', idx: c.sdpMLineIndex ?? -1, uf: c.usernameFragment ?? '',
  });
  function sendDescription(L) {
    const d = L.pc.localDescription;
    signal(L.id, { n: L.n, t: d.type === 'offer' ? SIG.offer : SIG.answer, s: d.sdp });
    L.sent = true;
    for (const c of L.outCands.splice(0)) sendCandidate(L, c);
  }
  async function applyRemote(L, desc) {
    await L.pc.setRemoteDescription(desc);
    L.remote = true;
    for (const c of L.inCands.splice(0)) L.pc.addIceCandidate(c).catch(() => {});
  }
  async function connectTo(id) {
    if (left || links.has(id) || !(selfId < id)) return;
    const L = makeLink(id, randomId(8));
    try {
      await L.pc.setLocalDescription(await L.pc.createOffer());
      if (links.get(id) === L) sendDescription(L);
    } catch (e) {
      console.warn('offer не вдався', e);
      dropLink(L, true);
    }
  }
  const failWarned = new Set();
  function dropLink(L, retry) {
    if (links.get(L.id) !== L) return;
    links.delete(L.id);
    clearTimeout(L.timer);
    clearTimeout(L.discTimer);
    try { L.r.close(); L.u.close(); } catch {}
    try { L.pc.close(); } catch {}
    if (L.open) peerClosed(L.id);
    else if (retry && inRoom.has(L.id) && !failWarned.has(L.id)) {
      failWarned.add(L.id);
      onWarn('link');
    }
    if (!retry || left) return;
    setTimeout(() => {
      if (left || links.has(L.id) || !inRoom.has(L.id)) return;
      if (selfId < L.id) connectTo(L.id);
      else signal(L.id, { n: '-', t: SIG.ask });                 // offer робить інший — просимо почати заново
    }, RETRY_MS);
  }
  async function onSignal(from, d) {
    if (left) return;
    let L = links.get(from);
    if (d.t === SIG.ask) {                                       // інший бік втратив з'єднання: перепідключаємось
      if (selfId > from) return;
      if (L) dropLink(L, false);
      connectTo(from);
      return;
    }
    if (d.t === SIG.offer) {
      if (selfId < from) return;                                 // offer має робити менший id
      if (L) dropLink(L, false);                                 // новий offer замінює попереднє з'єднання
      L = makeLink(from, d.n);
      try {
        await applyRemote(L, { type: 'offer', sdp: d.s });
        await L.pc.setLocalDescription(await L.pc.createAnswer());
        if (links.get(from) === L) sendDescription(L);
      } catch (e) {
        console.warn('answer не вдався', e);
        dropLink(L, true);
      }
      return;
    }
    if (!L || L.n !== d.n) return;                               // сигнал застарілої спроби
    if (d.t === SIG.answer && !L.remote) {
      try { await applyRemote(L, { type: 'answer', sdp: d.s }); } catch (e) { dropLink(L, true); }
    } else if (d.t === SIG.cand) {
      const c = { candidate: d.s, sdpMid: d.mid || null, sdpMLineIndex: d.idx < 0 ? null : d.idx, usernameFragment: d.uf || null };
      if (L.remote) L.pc.addIceCandidate(c).catch(() => {}); else L.inCands.push(c);
    }
  }

  // ---------- Сервер сигналізації ----------
  let ws = null, wsBackoff = 500, wsTimer = 0, welcomed = false, roomFull = false, outdated = false, turnMissing = false;
  let serverDownSince = performance.now();
  const serverMsg = (type, fill) => { const w = new Writer(); w.num('u8', type); fill(w); return w.bytes(); };
  function signal(to, d) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(serverMsg(TO_SERVER.signal, (w) => { put(w, 'str', to); put(w, SIGNAL_SCHEMA, d); })); } catch {}
  }
  function openSignal() {
    if (left || roomFull || outdated || ws) return;
    clearTimeout(wsTimer);
    let sock;
    try { sock = new WebSocket(url); } catch { return scheduleSignal(); }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      wsBackoff = 500;
      sock.send(serverMsg(TO_SERVER.join, (w) => { w.num('u8', PROTOCOL); put(w, 'str', game); put(w, 'str', room); put(w, 'str', selfId); }));
    };
    sock.onmessage = (e) => { if (ws === sock) onServer(e.data); };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === CLOSE_VERSION) { outdated = true; onWarn('outdated'); }
      if (serverDownSince === null) serverDownSince = performance.now();
      scheduleSignal();
      onChange();
    };
    sock.onerror = () => {};
  }
  function scheduleSignal() {
    if (left || roomFull || outdated) return;
    clearTimeout(wsTimer);
    wsTimer = setTimeout(openSignal, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 15000);
  }
  // Повернулися з фону / з'явилася мережа: відновлюємо зв'язок із сервером без очікування
  function wake() {
    if (ws || left || roomFull || outdated || !started) return;
    wsBackoff = 500;
    openSignal();
  }

  function onServer(raw) {
    if (!raw || typeof raw.byteLength !== 'number' || !raw.byteLength) return;
    const r = new Reader(new Uint8Array(raw));
    let type, m;
    try {
      type = r.num('u8');
      if (type === FROM_SERVER.welcome) m = { peers: get(r, ['str']), ice: get(r, ICE_SCHEMA) };
      else if (type === FROM_SERVER.joined || type === FROM_SERVER.left) m = { id: get(r, 'str') };
      else if (type === FROM_SERVER.signal) m = { from: get(r, 'str'), d: get(r, SIGNAL_SCHEMA) };
      else if (type !== FROM_SERVER.full) return;
      if (r.left()) return;
    } catch { return; }

    if (type === FROM_SERVER.welcome) {
      const again = welcomed;
      welcomed = true;
      serverDownSince = null;
      ice = iceServers.concat(m.ice);
      turnMissing = !m.ice.length;
      inRoom = new Set(m.peers.filter(id => isId(id) && id !== selfId));
      for (const id of inRoom) {
        const L = links.get(id);
        if (L && L.open) continue;
        if (selfId < id) connectTo(id);
        else if (again) signal(id, { n: '-', t: SIG.ask });      // після перепідключення до сервера
      }
      onWelcome(inRoom.size, again);
      onChange();
    } else if (type === FROM_SERVER.joined) {
      if (!isId(m.id) || m.id === selfId) return;
      inRoom.add(m.id);
      failWarned.delete(m.id);
      const L = links.get(m.id);
      if (selfId < m.id && !(L && L.open)) {
        if (L) dropLink(L, false);
        connectTo(m.id);
      }
    } else if (type === FROM_SERVER.left) {
      inRoom.delete(m.id);
      const L = links.get(m.id);
      if (L && !L.open) dropLink(L, false);                      // відкрите P2P-з'єднання не чіпаємо: воно знає краще
    } else if (type === FROM_SERVER.signal) {
      if (isId(m.from)) onSignal(m.from, m.d);
    } else {
      roomFull = true;
      onWarn('full');
    }
  }

  // ---------- Якість з'єднань ----------
  // Обрана ICE-пара: host з обох боків — локальна мережа, relay з будь-якого боку — через TURN, інакше — напряму через NAT.
  async function linkStat(L) {
    const stats = await L.pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s; });  // Firefox
    const loc = pair && stats.get(pair.localCandidateId), rem = pair && stats.get(pair.remoteCandidateId);
    if (!loc || !rem) return null;
    const type = loc.candidateType === 'relay' ? (loc.relayProtocol === 'tls' ? 'TURN/TLS' : 'TURN')
      : rem.candidateType === 'relay' ? 'TURN'
      : loc.candidateType === 'host' && rem.candidateType === 'host' ? 'LAN' : 'P2P';
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    let rtt = isNum(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null;
    if (rtt === null && isNum(pair.totalRoundTripTime) && isNum(pair.responsesReceived)) {   // без currentRoundTripTime — середнє за інтервал
      const dn = pair.responsesReceived - (L.rttN || 0);
      if (dn > 0) rtt = (pair.totalRoundTripTime - (L.rttT || 0)) / dn;
      L.rttN = pair.responsesReceived; L.rttT = pair.totalRoundTripTime;
    }
    return { type, rtt: rtt === null ? null : Math.round(rtt * 1000) };
  }
  function pollStats() {
    for (const L of links.values()) {
      if (!L.open) continue;
      linkStat(L).then((st) => {
        if (links.get(L.id) !== L || JSON.stringify(st) === JSON.stringify(L.stat)) return;
        L.stat = st;
        onChange();
      }, () => {});
    }
  }

  // ---------- Таймери і події сторінки ----------
  let tick = 0, lastLive = -1;
  function housekeeping() {
    checkResume();
    tick++;
    const now = performance.now();
    for (const [id, p] of peers) {
      if (!p.direct && now - p.seen > FORGET_MS) { peers.delete(id); onPeerGone(id); }
    }
    if (tick % HELLO_EVERY === 0 && peers.size) sendHello();
    const host = hostId();
    if (host !== selfId && peers.has(host)) askClock(host);
    const live = liveCount();
    if (live !== lastLive) { lastLive = live; onChange(); }      // хтось зник без прощання
    if (serverDownSince !== null) onChange();                    // попередження про сервер з'являється із затримкою
    if (tick % 2 === 0 && !document.hidden) pollStats();
  }

  // Вихід: прощаємось явно, щоб інші прибрали гравця одразу
  function leave() {
    if (left) return;
    left = true;
    send('bye', {});
    clearTimeout(wsTimer);
    if (ws) { try { ws.close(1000); } catch {} }                 // сервер одразу повідомить інших (left)
    // WebRTC-з'єднання закриє сам браузер при вивантаженні сторінки — після того, як піде bye
  }

  function start() {
    if (started) return;
    started = true;
    lastBeat = performance.now();
    setInterval(housekeeping, 1000);
    // Вкладка у фоні: віддаємо роль хоста, повернулися — стаємо в кінець черги
    document.addEventListener('visibilitychange', () => {
      onVisibility(document.hidden);                             // напр., хост встигає розіслати свіжий стан
      if (document.hidden) sendHello();
      else { restamp(); wake(); }
      onChange();
    });
    addEventListener('online', wake);
    addEventListener('pagehide', leave);
    addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });   // повернення з bfcache — з'єднання вже закриті
    openSignal();
  }

  return {
    id: selfId,
    start,
    send,
    announce: () => sendHello(),                                 // змінився hasGame() — повідомити інших одразу
    restamp,                                                     // приєдналися до чужої гри — у кінець черги на хоста
    hostId,
    isHost,
    sharedNow,
    isLive: (id) => { const p = peers.get(id); return !!p && isLivePeer(p); },
    isAway: (id) => !!peers.get(id)?.away,
    liveCount,
    linkCount: () => { let n = 0; for (const L of links.values()) if (L.open) n++; return n; },
    // живі гравці для HUD: direct — є пряме з'єднання, stat — { type: 'LAN'|'P2P'|'TURN'|'TURN/TLS', rtt (мс) | null }
    peers: () => {
      const now = performance.now(), out = [];
      for (const [id, p] of peers) {
        if (isLivePeer(p, now)) out.push({ id, direct: p.direct, away: p.away, stat: p.direct ? links.get(id)?.stat ?? null : null });
      }
      return out;
    },
    // welcomed — сервер прийняв; downMs — скільки немає зв'язку з сервером; turn — сервер дав TURN
    status: () => ({
      welcomed, full: roomFull, outdated, turn: !turnMissing,
      downMs: serverDownSince === null ? 0 : performance.now() - serverDownSince,
    }),
  };
}
