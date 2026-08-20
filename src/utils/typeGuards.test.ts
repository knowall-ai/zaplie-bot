// typeGuards.test.ts

import { expect, describe, test } from '@jest/globals';
import { isRecord } from './typeGuards';

describe('isRecord', () => {
  test.each<[string, unknown]>([
    ['a plain object', {}],
    ['an object with properties', { a: 1, b: 'two' }],
    ['an array', []],
    ['a populated array', [1, 2, 3]],
    ['a Date instance', new Date()],
    ['a class instance', new Error('boom')],
  ])('returns true for %s', (_name, value) => {
    expect(isRecord(value)).toBe(true);
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'hello'],
    ['an empty string', ''],
    ['a number', 42],
    ['zero', 0],
    ['a boolean (true)', true],
    ['a boolean (false)', false],
    ['a function', () => {}],
    ['a symbol', Symbol('sym')],
  ])('returns false for %s', (_name, value) => {
    expect(isRecord(value)).toBe(false);
  });

  test('narrows the type so property access compiles without casts', () => {
    const value: unknown = { foo: 'bar' };
    if (isRecord(value)) {
      // This line only type-checks if isRecord narrows `unknown` to
      // `Record<string, unknown>` — a regression here would fail to compile.
      expect(value.foo).toBe('bar');
    } else {
      throw new Error('Expected isRecord to narrow the object.');
    }
  });
});