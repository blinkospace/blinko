import { describe, it, expect, beforeAll } from 'bun:test';

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';
const TIMEOUT = 30000;

describe('MiniMax API Integration', () => {
  const skip = !MINIMAX_API_KEY;

  beforeAll(() => {
    if (skip) {
      console.log('Skipping MiniMax integration tests: MINIMAX_API_KEY not set');
    }
  });

  it('should accept a valid API key for chat completions', async () => {
    if (skip) return;

    const response = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.5-highspeed',
        messages: [{ role: 'user', content: 'Reply with "ok"' }],
        max_tokens: 5,
        temperature: 0.1
      })
    });

    expect(response.ok).toBe(true);
    const data = await response.json() as any;
    expect(data.choices).toBeDefined();
    expect(data.choices[0].message.content).toBeTruthy();
  }, TIMEOUT);

  it('should complete a chat request with MiniMax-M2.5', async () => {
    if (skip) return;

    const response = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.5',
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
        max_tokens: 10,
        temperature: 0.1
      })
    });

    expect(response.ok).toBe(true);
    const data = await response.json() as any;
    expect(data.choices).toBeDefined();
    expect(data.choices.length).toBeGreaterThan(0);
    expect(data.choices[0].message.content).toBeTruthy();
  }, TIMEOUT);

  it('should support streaming with MiniMax API', async () => {
    if (skip) return;

    const response = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.5',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        temperature: 0.1,
        stream: true
      })
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(value).toBeTruthy();
    reader.cancel();
  }, TIMEOUT);
});
