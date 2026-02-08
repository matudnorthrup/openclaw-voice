import { describe, it, expect } from 'vitest';

describe('Claude LLM (via Gateway)', () => {
  it('should generate a response', async () => {
    if (!process.env['GATEWAY_TOKEN'] || process.env['GATEWAY_TOKEN'] === 'your_gateway_token_here') {
      console.log('GATEWAY_TOKEN not set, skipping API test');
      return;
    }

    const { getResponse, clearConversation } = await import('../src/services/claude.js');

    const response = await getResponse('test-user', 'Hello Watson, what is your name?');
    expect(response.length).toBeGreaterThan(0);
    expect(typeof response).toBe('string');

    clearConversation('test-user');
  });

  it('should maintain conversation history', async () => {
    if (!process.env['GATEWAY_TOKEN'] || process.env['GATEWAY_TOKEN'] === 'your_gateway_token_here') {
      console.log('GATEWAY_TOKEN not set, skipping API test');
      return;
    }

    const { getResponse, clearConversation } = await import('../src/services/claude.js');
    const userId = 'test-memory-user';

    // Tell it a fact
    await getResponse(userId, 'My favorite color is purple. Please remember that.');

    // Ask about it
    const response = await getResponse(userId, 'What is my favorite color?');
    expect(response.toLowerCase()).toContain('purple');

    clearConversation(userId);
  });
});
