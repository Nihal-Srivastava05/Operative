import { describe, expect, it } from 'vitest';
import { AgentRunner } from './AgentRunner';

describe('AgentRunner tool-call parsing', () => {
  const runner = new AgentRunner();

  it('extracts the primary expected shape {tool, arguments}', () => {
    const call = (runner as any).extractToolCall(
      JSON.stringify({ tool: 'navigate', arguments: { url: 'example.com' } }),
    );
    expect(call).toEqual({ tool: 'navigate', args: { url: 'example.com' } });
  });

  it('extracts wrapped tool_call shapes', () => {
    const call = (runner as any).extractToolCall(
      JSON.stringify({
        tool_call: { tool_name: 'type_input', arguments: { selector: '#q', text: 'hello' } },
      }),
    );
    expect(call).toEqual({ tool: 'type_input', args: { selector: '#q', text: 'hello' } });
  });

  it('canonicalizes the browser/action dialect', () => {
    const call = (runner as any).extractToolCall(
      JSON.stringify({ tool: 'browser', action: 'navigate', url: 'example.com' }),
    );
    expect(call).toEqual({ tool: 'navigate', args: { url: 'example.com' } });
  });

  it('lifts top-level args when arguments is missing', () => {
    const call = (runner as any).extractToolCall(JSON.stringify({ tool: 'click_element', selector: '#btn' }));
    expect(call).toEqual({ tool: 'click_element', args: { selector: '#btn' } });
  });

  it('normalizes navigate url to https:// when missing scheme', () => {
    const args = (runner as any).normalizeToolArgs('navigate', { url: 'example.com' });
    expect(args.url).toBe('https://example.com');
  });
});

