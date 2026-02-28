import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Claude session-key header behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends x-openclaw-session-key and canonical user in completion requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { getResponse } = await import('../src/services/claude.js');
    const sessionKey = 'agent:main:discord:channel:12345';

    const result = await getResponse(sessionKey, 'hello', { history: [] });
    expect(result.response).toBe('ok');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));

    expect(headers['x-openclaw-session-key']).toBe(sessionKey);
    expect(body.user).toBe(sessionKey);
  });

  it('retries without x-openclaw-session-key when gateway rejects the header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unsupported header: x-openclaw-session-key', { status: 400 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

    vi.stubGlobal('fetch', fetchMock);

    const { getResponse } = await import('../src/services/claude.js');
    const sessionKey = 'agent:main:discord:channel:67890';

    const result = await getResponse(sessionKey, 'hello', { history: [] });
    expect(result.response).toBe('fallback-ok');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;

    const firstHeaders = firstInit.headers as Record<string, string>;
    const secondHeaders = secondInit.headers as Record<string, string>;

    expect(firstHeaders['x-openclaw-session-key']).toBe(sessionKey);
    expect(secondHeaders['x-openclaw-session-key']).toBeUndefined();
  });
});
