import { expect, test } from 'bun:test';
import { decodeStoredF32 } from '../../services/pluginServices/VectorRepository';

const words = [0x3dcccccd, 0xc0200000, 0x00000001, 0x7f7fffff, 0x00000000, 0x80000000];
const expected = [Math.fround(0.1), -2.5, 2 ** -149, (2 - 2 ** -23) * 2 ** 127, 0, -0];
function fixture(offset = 0) {
  const buffer = new ArrayBuffer(offset + words.length * 4 + 5);
  const view = new DataView(buffer, offset, words.length * 4);
  words.forEach((word, i) => view.setUint32(i * 4, word, true));
  return { buffer, view, bytes: new Uint8Array(buffer, offset, words.length * 4) };
}

test('F32 blobs retain exact little-endian values, signed zero and finite boundary values', () => {
  const { bytes } = fixture();
  const values = decodeStoredF32(bytes, words.length);
  expect(Array.isArray(values)).toBe(true);
  expected.forEach((value, i) => expect(Object.is(values[i], value)).toBe(true));
});

test('ArrayBuffer views honor byte offsets and lengths even when unaligned', () => {
  const { buffer, view, bytes } = fixture(1);
  const values = [bytes, view, Buffer.from(buffer, 1, words.length * 4)];
  for (const input of values) {
    const result = decodeStoredF32(input, words.length);
    expected.forEach((value, i) => expect(Object.is(result[i], value)).toBe(true));
  }
  expect(() => decodeStoredF32(buffer, words.length)).toThrow();
});

test('all 1024 axes decode, including the last axis, as an ordinary independent number array', () => {
  const buffer = new ArrayBuffer(1024 * 4), view = new DataView(buffer);
  const expected = Array.from({ length: 1024 }, (_, i) => Math.fround((i % 97 - 48) / 17));
  expected.forEach((value, i) => view.setFloat32(i * 4, value, true));
  const values = decodeStoredF32(buffer, 1024);
  expect(values).toEqual(expected);
  view.setFloat32(1023 * 4, 999, true);
  expect(values[1023]).toBe(expected[1023]);
  values[0] = 17;
  expect(view.getFloat32(0, true)).toBe(expected[0]);
});

test('malformed lengths and non-binary inputs remain rejected', () => {
  for (const value of [new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(7), new ArrayBuffer(12), [1, 2], 'binary', null]) {
    expect(() => decodeStoredF32(value, 2)).toThrow();
  }
});

test('NaN, infinities and zero-only vectors remain rejected', () => {
  for (const word of [0x7fc00000, 0x7f800000, 0xff800000, 0x00000000, 0x80000000]) {
    const buffer = new ArrayBuffer(8), view = new DataView(buffer);
    view.setUint32(0, word, true);
    expect(() => decodeStoredF32(buffer, 2)).toThrow();
  }
});
