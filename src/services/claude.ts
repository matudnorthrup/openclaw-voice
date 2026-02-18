import { config } from '../config.js';
import { WATSON_SYSTEM_PROMPT } from '../prompts/watson-system.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface GetResponseOptions {
  systemPrompt?: string;
  history?: Message[];
}

export interface GetResponseResult {
  response: string;
  history: Message[];
}

const MAX_HISTORY = 20;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;
const conversations = new Map<string, Message[]>();

async function fetchWithRetry(url: string, init: RequestInit, label: string, signal?: AbortSignal): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) break;
    try {
      const fetchInit = signal ? { ...init, signal } : init;
      return await fetch(url, fetchInit);
    } catch (err: any) {
      lastError = err;
      // Don't retry if the caller's abort signal fired — budget is exhausted.
      if (signal?.aborted) break;
      if (attempt < MAX_RETRIES) {
        console.warn(`${label} fetch failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError!;
}

export async function getResponse(
  userId: string,
  text: string,
  options?: GetResponseOptions,
): Promise<GetResponseResult> {
  const start = Date.now();

  const systemPrompt = options?.systemPrompt ?? WATSON_SYSTEM_PROMPT;
  const externalHistory = options?.history !== undefined;

  let history = externalHistory ? options!.history! : (conversations.get(userId) || []);
  history.push({ role: 'user', content: text });

  // Trim to last MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  // Build messages array with system prompt
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
  ];

  const apiResponse = await fetchWithRetry(`${config.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.gatewayToken}`,
    },
    body: JSON.stringify({
      model: `openclaw:${config.gatewayAgentId}`,
      max_tokens: 300,
      messages,
      user: userId,
    }),
  }, 'Claude LLM');

  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Gateway API error ${apiResponse.status}: ${body}`);
  }

  const data = await apiResponse.json() as any;
  const assistantText = data.choices?.[0]?.message?.content || '';

  history.push({ role: 'assistant', content: assistantText });

  if (!externalHistory) {
    conversations.set(userId, history);
  }

  const elapsed = Date.now() - start;
  console.log(`Claude LLM (via gateway): "${assistantText.slice(0, 80)}..." (${elapsed}ms)`);

  return { response: assistantText, history };
}

export async function quickCompletion(systemPrompt: string, userMessage: string, maxTokens = 50, signal?: AbortSignal): Promise<string> {
  const start = Date.now();

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const sessionKey = `agent:${config.gatewayAgentId}:discord:channel:${config.utilityChannelId}`;

  const apiResponse = await fetchWithRetry(`${config.gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.gatewayToken}`,
    },
    body: JSON.stringify({
      model: `openclaw:${config.gatewayAgentId}`,
      max_tokens: maxTokens,
      messages,
      user: sessionKey,
    }),
  }, 'Quick completion', signal);

  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Gateway API error ${apiResponse.status}: ${body}`);
  }

  const data = await apiResponse.json() as any;
  const result = data.choices?.[0]?.message?.content?.trim() || '';

  const elapsed = Date.now() - start;
  console.log(`Quick completion (${elapsed}ms): "${result}"`);

  return result;
}

export function clearConversation(userId: string): void {
  conversations.delete(userId);
  console.log(`Cleared conversation for ${userId}`);
}
