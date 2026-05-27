// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

export interface OpenRouterObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  siteUrl?: string;
  appName?: string;
  baseUrl?: string;
  providerLabel?: 'openrouter' | 'openai-compatible' | 'opencode-go';
  providerDisplayName?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class OpenRouterObservationProvider implements ServerGenerationProvider {
  readonly providerLabel: 'openrouter' | 'openai-compatible' | 'opencode-go';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly baseUrl: string;
  private readonly providerDisplayName: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('OpenRouter API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.siteUrl = options.siteUrl ?? 'https://github.com/thedotmack/claude-mem';
    this.appName = options.appName ?? 'claude-mem';
    this.baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
    this.providerLabel = options.providerLabel ?? 'openrouter';
    this.providerDisplayName = options.providerDisplayName ?? 'OpenRouter';
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(buildChatCompletionsUrl(this.baseUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'HTTP-Referer': this.siteUrl,
          'X-Title': this.appName,
          'Content-Type': 'application/json',
          ...this.extraHeaders,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: this.maxOutputTokens,
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyHttpProviderError({
        cause: networkError,
        providerLabel: this.providerDisplayName,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`${this.providerDisplayName} API error: ${response.status} - ${bodyText}`),
        providerLabel: this.providerDisplayName,
      });
    }

    let data: OpenRouterResponse;
    try {
      data = (await response.json()) as OpenRouterResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('OpenRouter returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`${this.providerDisplayName} API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: this.providerDisplayName,
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', `${this.providerDisplayName} returned empty content`, {
        provider: this.providerLabel,
        model: this.model,
      });
    }

    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}
