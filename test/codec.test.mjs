// Двійковий формат net.js: кодування, межі типів, сувора перевірка при декодуванні
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../v1/net.js';

test('кодування і декодування всіх типів', () => {
  const S = { x: 'u16', y: 'i16', f: 'f32', d: 'f64', b: 'bool', s: 'str', a: ['u16'], o: [{ k: 'u8', z: 'str' }], by: 'bytes' };
  const v = { x: 900, y: -5, f: 1.5, d: 1790000000123.5, b: true, s: 'Пожежа 🔥', a: [1, 2, 400], o: [{ k: 7, z: 'a' }], by: new Uint8Array([1, 2, 3]) };
  assert.deepEqual(decode(S, encode(S, v)), v);
});

test('цілі при записі округлюються й обрізаються, відсутні поля — нулі', () => {
  const S = { a: 'u8', b: 'i8', c: 'u16' };
  assert.deepEqual(decode(S, encode(S, { a: 300, b: -200, c: 12.6 })), { a: 255, b: -128, c: 13 });
  const E = { a: 'u8', s: 'str', l: ['u8'] };
  assert.deepEqual(decode(E, encode(E, {})), { a: 0, s: '', l: [] });
});

test('некоректні дані відкидаються', () => {
  const bad = (schema, bytes) => assert.throws(() => decode(schema, new Uint8Array(bytes)));
  bad({ a: 'u16' }, [1]);                              // коротко
  bad({ a: 'u8' }, [1, 2]);                            // зайвий байт
  bad({ b: 'bool' }, [2]);                             // bool не 0/1
  bad({ f: 'f64' }, [0, 0, 0, 0, 0, 0, 0xf8, 0x7f]);   // NaN
  bad({ s: 'str' }, [2, 0xff, 0xfe]);                  // битий UTF-8
  bad({ l: ['u8'] }, [200, 1]);                        // довжина більша за дані
  bad({ l: [{}] }, [0xff, 0xff, 0x7f]);                // багато порожніх елементів
  bad({ v: 'str' }, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);  // varint
});
