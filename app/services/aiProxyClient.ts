/**
 * Proxies AI API calls through Supabase Edge Function `ai-proxy` so secrets stay server-side.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AxiosError } from 'axios';
import { EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_SUPABASE_URL } from '@env';
import { ensureAnonymousSessionForGuest } from './authService';
import { supabase } from './supabaseClient';
import { logger } from '../utils/logger';

/** Must match AuthContext GUEST_MODE_STORAGE_KEY */
const GUEST_MODE_STORAGE_KEY = '@worddex_guest_mode';

export type AiProxyProvider = 'claude' | 'gemini' | 'vision';

/** Shape of Anthropic Messages API JSON response (fields used by claudeApi). */
export interface AnthropicMessagesData {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AiProxyCallOptions {
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** Only used when provider === 'gemini' */
  geminiModel?: string;
}

function throwAxiosCompatibleError(status: number, data: unknown): never {
  const err = new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    undefined,
    undefined,
    {
      status,
      statusText: '',
      data,
      headers: {},
      config: {} as never,
    }
  );
  throw err;
}

/**
 * Calls the ai-proxy edge function. Returns the upstream JSON body (same shape as direct API).
 * On HTTP errors, throws AxiosError-compatible errors so existing catch (AxiosError) paths work.
 */
export async function callAiProxy(
  provider: AiProxyProvider,
  body: unknown,
  options?: AiProxyCallOptions
): Promise<unknown> {
  const { data: sessionData } = await supabase.auth.getSession();
  let token = sessionData.session?.access_token;
  if (!token) {
    const isGuest = await AsyncStorage.getItem(GUEST_MODE_STORAGE_KEY);
    if (isGuest === 'true') {
      const { error } = await ensureAnonymousSessionForGuest();
      if (!error) {
        const { data: retryData } = await supabase.auth.getSession();
        token = retryData.session?.access_token ?? undefined;
      }
    }
    if (!token) {
      throw new Error('Not authenticated. Sign in to use AI features.');
    }
  }

  const url = `${EXPO_PUBLIC_SUPABASE_URL}/functions/v1/ai-proxy`;
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 120000;
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: EXPO_PUBLIC_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        body,
        extraHeaders: options?.extraHeaders,
        geminiModel: options?.geminiModel,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      logger.warn(`[ai-proxy] ${provider} failed: ${res.status}`, parsed);
      throwAxiosCompatibleError(res.status, parsed);
    }

    return parsed;
  } finally {
    clearTimeout(tid);
  }
}

/** Drop-in replacement for axios.post to Anthropic Messages API. Strips client x-api-key if present. */
export async function anthropicPost(
  messagesBody: Record<string, unknown>,
  axiosLikeConfig?: { headers?: Record<string, string | number | boolean | undefined>; timeout?: number }
): Promise<{ data: AnthropicMessagesData; headers: Record<string, string> }> {
  const extraHeaders: Record<string, string> = {};
  const h = axiosLikeConfig?.headers || {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'x-api-key') continue;
    if (v !== undefined && v !== null) extraHeaders[k] = String(v);
  }
  const data = (await callAiProxy('claude', messagesBody, {
    extraHeaders,
    timeoutMs: axiosLikeConfig?.timeout,
  })) as AnthropicMessagesData;
  return { data, headers: {} };
}

export async function geminiGenerateContent(
  model: string,
  requestBody: Record<string, unknown>,
  timeoutMs?: number
): Promise<{ data: unknown }> {
  const data = await callAiProxy('gemini', requestBody, {
    geminiModel: model,
    timeoutMs: timeoutMs ?? 30000,
  });
  return { data };
}

export async function visionAnnotate(
  requestBody: Record<string, unknown>,
  timeoutMs?: number
): Promise<{ data: unknown }> {
  const data = await callAiProxy('vision', requestBody, {
    timeoutMs: timeoutMs ?? 120000,
  });
  return { data };
}
