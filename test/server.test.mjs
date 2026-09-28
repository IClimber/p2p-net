// Протокол сервера сигналізації на логіці createSignalServer із фейковими сокетами
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSignalServer } from '../server/signal.mjs';
import { decode } from '../v1/net.js';

const str = (x) => { const b = Buffer.from(x); return Buffer.concat([Buffer.from([b.length]), b]); };
const join = (v, game, room, id) => Buffer.concat([Buffer.from([1, v]), str(game), str(room), str(id)]);
const WELCOME = { peers: ['str'], ice: [{ urls: ['str'], username: 'str', credential: 'str' }] };

function setup() {
  const server = createSignalServer({ turnSecret: 's', turnUrls: ['turn:1.2.3.4:3478?transport=udp'] });
  const sock = (ip = 'x') => {
    const s = new EventEmitter();
    s.sent = []; s.send = (b) => s.sent.push(b); s.close = (code) => { s.code = code; s.emit('close'); }; s.ping = () => {};
    server.handleConnection(s, { ip });
    s.msg = (b) => s.emit('message', b, true);
    return s;
  };
  return { server, sock };
}

test('welcome, joined, signal, left', () => {
  const { server, sock } = setup();
  const a = sock(), b = sock();
  a.msg(join(2, 'game', 'r', 'aaaaaaaa'));
  b.msg(join(2, 'game', 'r', 'bbbbbbbb'));
  const w = decode(WELCOME, new Uint8Array(b.sent[0].subarray(1)));
  assert.equal(b.sent[0][0], 1);
  assert.deepEqual(w.peers, ['aaaaaaaa']);
  assert.match(w.ice[0].username, /^\d+:[0-9a-f]{16}$/);
  assert.equal(a.sent[1][0], 2);                                  // joined
  b.msg(Buffer.concat([Buffer.from([2]), str('aaaaaaaa'), Buffer.from([9, 8, 7])]));
  assert.deepEqual([...a.sent[2]], [4, 8, ...Buffer.from('bbbbbbbb'), 9, 8, 7]);   // дані пересилаються як є
  b.close(1000);
  assert.equal(a.sent[3][0], 3);                                  // left
  server.stop();
});

test('кімнати розділені за грою', () => {
  const { server, sock } = setup();
  const a = sock(), b = sock();
  a.msg(join(2, 'one', 'same', 'aaaaaaaa'));
  b.msg(join(2, 'two', 'same', 'bbbbbbbb'));
  assert.deepEqual(decode(WELCOME, new Uint8Array(b.sent[0].subarray(1))).peers, []);
  server.stop();
});

test('стара версія і некоректні дані', () => {
  const { server, sock } = setup();
  const t = sock(); t.emit('message', Buffer.from('{"t":"join"}'), false);
  assert.equal(t.code, 4005, 'текстовий кадр');
  const v = sock(); v.msg(join(1, 'game', 'r', 'aaaaaaaa'));
  assert.equal(v.code, 4005, 'інша версія протоколу');
  const g = sock(); g.msg(join(2, 'Bad Game', 'r', 'aaaaaaaa'));
  assert.equal(g.code, 4001, 'некоректна назва гри');
  const c = sock(); c.msg(Buffer.from([1, 2, 200]));
  assert.equal(c.code, undefined, 'обрізаний join не валить сервер');
  server.stop();
});

test('кімната заповнена', () => {
  const { server, sock } = setup();
  for (let i = 0; i < 16; i++) sock('ip' + i).msg(join(2, 'game', 'r', 'id' + String(i).padStart(6, '0')));
  const x = sock('last'); x.msg(join(2, 'game', 'r', 'overflow1'));
  assert.equal(x.sent[0][0], 5);
  assert.equal(x.code, 4002);
  server.stop();
});
