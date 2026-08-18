// SSOCommandMap.test.ts

import {
  SSOCommand,
  SSOCommandMap,
  normalizeCommandText,
} from './SSOCommandMap';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

class FakeCommand extends SSOCommand {
  execute = jest.fn();
}

describe('normalizeCommandText', () => {
  test('lowercases, trims and collapses whitespace', () => {
    expect(normalizeCommandText('  Send \t  Zap  ')).toBe('send zap');
  });

  test('drops trailing sentence punctuation', () => {
    expect(normalizeCommandText('Send zap.')).toBe('send zap');
    expect(normalizeCommandText('send zap!!')).toBe('send zap');
    expect(normalizeCommandText('show my balance ?')).toBe('show my balance');
  });
});

describe('SSOCommandMap.match', () => {
  let sendZap: FakeCommand;
  let showBalance: FakeCommand;

  beforeEach(() => {
    sendZap = new FakeCommand();
    showBalance = new FakeCommand();
    SSOCommandMap.register('send zap', sendZap);
    SSOCommandMap.register('show my balance', showBalance);
  });

  test('matches an exact command', () => {
    expect(SSOCommandMap.match('send zap')).toBe(sendZap);
  });

  test('is tolerant of case and extra whitespace', () => {
    expect(SSOCommandMap.match('  SEND   Zap ')).toBe(sendZap);
  });

  test('matches a message that starts with a known command', () => {
    expect(SSOCommandMap.match('send zap to bob')).toBe(sendZap);
    expect(SSOCommandMap.match('Show my balance please')).toBe(showBalance);
  });

  test('tolerates trailing punctuation', () => {
    expect(SSOCommandMap.match('send zap.')).toBe(sendZap);
    expect(SSOCommandMap.match('Send zap!')).toBe(sendZap);
    expect(SSOCommandMap.match('send zap to bob?')).toBe(sendZap);
  });

  test('does not match a prefix without a word boundary', () => {
    expect(SSOCommandMap.match('send zapping everyone')).toBeUndefined();
  });

  test('returns undefined for unknown or empty text', () => {
    expect(SSOCommandMap.match('dance for me')).toBeUndefined();
    expect(SSOCommandMap.match('   ')).toBeUndefined();
  });
});

describe('SSOCommandMap.commandNames', () => {
  test('lists the registered command names', () => {
    SSOCommandMap.register('send zap', new FakeCommand());
    expect(SSOCommandMap.commandNames()).toContain('send zap');
  });
});
