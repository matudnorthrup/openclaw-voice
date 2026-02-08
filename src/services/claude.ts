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
const conversations = new Map<string, Message[]>();

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

  const apiResponse = await fetch(`${config.gatewayUrl}/v1/chat/completions`, {
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
  });

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

export function clearConversation(userId: string): void {
  conversations.delete(userId);
  console.log(`Cleared conversation for ${userId}`);
}
