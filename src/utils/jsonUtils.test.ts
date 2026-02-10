import { describe, expect, it } from 'vitest';
import { extractJson } from './jsonUtils';

describe('extractJson', () => {
  it('parses strict JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside markdown fences', () => {
    const input = ['```json', '{"tool":"navigate","arguments":{"url":"https://example.com"}}', '```'].join(
      '\n',
    );
    expect(extractJson(input)).toEqual({
      tool: 'navigate',
      arguments: { url: 'https://example.com' },
    });
  });

  it('returns null when no JSON exists', () => {
    expect(extractJson('hello world', { logFailure: false })).toBeNull();
  });
});

