import { config } from '../config.js';
import { WATSON_SYSTEM_PROMPT } from '../prompts/watson-system.js';
import { GatewaySync } from './gateway-sync.js';

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
const GATEWAY_SESSION_HEADER = 'x-openclaw-session-key';

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

function shouldRetryWithoutSessionHeader(status: number, body: string): boolean {
  if (![400, 404, 422].includes(status)) return false;
  const lower = body.toLowerCase();
  return lower.includes('x-openclaw-session-key')
    || lower.includes('session-key')
    || lower.includes('unknown header')
    || lower.includes('unsupported header');
}

async function requestGatewayCompletion(params: {
  messages: Message[];
  maxTokens: number;
  sessionKey: string;
  label: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const url = `${config.gatewayUrl}/v1/chat/completions`;
  const body = JSON.stringify({
    model: `openclaw:${config.gatewayAgentId}`,
    max_tokens: params.maxTokens,
    messages: params.messages,
    // Keep `user` for backward compatibility if header routing is unavailable.
    user: params.sessionKey,
  });

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.gatewayToken}`,
  };

  let apiResponse = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      [GATEWAY_SESSION_HEADER]: params.sessionKey,
    },
    body,
  }, params.label, params.signal);

  if (apiResponse.ok) {
    return apiResponse;
  }

  const firstErrorBody = await apiResponse.text();
  if (shouldRetryWithoutSessionHeader(apiResponse.status, firstErrorBody)) {
    console.warn(
      `${params.label}: gateway rejected ${GATEWAY_SESSION_HEADER}; retrying without header`,
    );
    apiResponse = await fetchWithRetry(url, {
      method: 'POST',
      headers: baseHeaders,
      body,
    }, params.label, params.signal);

    if (apiResponse.ok) {
      return apiResponse;
    }

    const retryBody = await apiResponse.text();
    throw new Error(`Gateway API error ${apiResponse.status}: ${retryBody}`);
  }

  throw new Error(`Gateway API error ${apiResponse.status}: ${firstErrorBody}`);
}

export async function getResponse(
  userId: string,
  text: string,
  options?: GetResponseOptions,
): Promise<GetResponseResult> {
  const start = Date.now();
  const normalizedUserId = GatewaySync.normalizeCompletionUserId(userId);
  const openAiDepth = GatewaySync.countOpenAiUserPrefixes(userId);
  if (openAiDepth > 1 || normalizedUserId !== userId) {
    console.warn(`Normalized gateway completion user "${userId}" -> "${normalizedUserId}" (openaiDepth=${openAiDepth})`);
  }

  const systemPrompt = options?.systemPrompt ?? WATSON_SYSTEM_PROMPT;
  const externalHistory = options?.history !== undefined;

  let history = externalHistory ? options!.history! : (conversations.get(normalizedUserId) || []);
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

  const apiResponse = await requestGatewayCompletion({
    messages,
    maxTokens: 300,
    sessionKey: normalizedUserId,
    label: 'Claude LLM',
  });

  const data = await apiResponse.json() as any;
  const rawText = data.choices?.[0]?.message?.content || '';

  // Strip phantom user messages that the gateway's prompt formatting can induce.
  // The gateway wraps the latest user turn with "[Current message - respond to this]"
  // and Claude sometimes hallucinates a continuation containing a fabricated user
  // turn after its actual response.  Truncate at the marker boundary.
  const assistantText = stripPhantomUserTurn(rawText);

  history.push({ role: 'assistant', content: assistantText });

  if (!externalHistory) {
    conversations.set(normalizedUserId, history);
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

  const sessionKey = GatewaySync.normalizeCompletionUserId(
    `agent:${config.gatewayAgentId}:discord:channel:${config.utilityChannelId}`,
  );

  const apiResponse = await requestGatewayCompletion({
    messages,
    maxTokens,
    sessionKey,
    label: 'Quick completion',
    signal,
  });

  const data = await apiResponse.json() as any;
  const result = data.choices?.[0]?.message?.content?.trim() || '';

  const elapsed = Date.now() - start;
  console.log(`Quick completion (${elapsed}ms): "${result}"`);

  return result;
}

export function clearConversation(userId: string): void {
  const normalizedUserId = GatewaySync.normalizeCompletionUserId(userId);
  conversations.delete(normalizedUserId);
  console.log(`Cleared conversation for ${normalizedUserId}`);
}

/**
 * Strip phantom user turns that appear at the tail of a gateway response.
 *
 * The OpenClaw gateway wraps the latest user message with a
 * "[Current message - respond to this]" marker.  Claude occasionally
 * hallucinates past its actual answer and generates a fake next user
 * turn following that marker.  This function truncates the response at
 * the marker boundary so the fabricated content never reaches TTS,
 * Discord logging, or conversation history.
 */
function stripPhantomUserTurn(text: string): string {
  // Match the gateway's injected marker (case-insensitive, flexible punctuation)
  const idx = text.search(/\[Current message[\s\S]{0,30}respond to this\]/i);
  if (idx > 0) {
    const cleaned = text.slice(0, idx).trimEnd();
    console.warn(`Stripped phantom user turn from response (removed ${text.length - cleaned.length} chars)`);
    return cleaned;
  }
  return text;
}
