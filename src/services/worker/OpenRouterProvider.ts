
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  type WorkerRef
} from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

/**
 * Parse Retry-After header (seconds or HTTP-date). Returns ms or undefined.
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Classify an OpenRouter fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 */
export function classifyOpenAICompatibleError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
  providerName?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;
  const providerName = input.providerName ?? 'OpenAI-compatible provider';

  // Quota / insufficient credits — body marker takes precedence over status.
  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota')
  ) {
    return new ClassifiedProviderError(
      `${providerName} quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      `${providerName} rate limit (429)`,
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `${providerName} auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `${providerName} bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `${providerName} upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `${providerName} network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `${providerName} API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

export function classifyOpenRouterError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  return classifyOpenAICompatibleError({ ...input, providerName: 'OpenRouter' });
}

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  
const CHARS_PER_TOKEN_ESTIMATE = 4;  

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export type OpenAICompatibleProviderId = 'openrouter' | 'openai-compatible' | 'opencode-go';

export interface OpenAICompatibleConfig {
  providerId: OpenAICompatibleProviderId;
  providerName: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  maxContextMessages: number;
  maxEstimatedTokens: number;
}

export interface OpenAICompatibleQueryOptions {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export function parseOpenAICompatibleHeaders(value: string | undefined): Record<string, string> {
  if (!value || !value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON must be a JSON object');
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof headerValue !== 'string') {
      throw new Error('CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON values must be strings');
    }
    headers[key] = headerValue;
  }
  return headers;
}

export async function queryOpenAICompatibleChatCompletion(
  options: OpenAICompatibleQueryOptions,
): Promise<{ content: string; tokensUsed?: number; usage?: OpenAICompatibleResponse['usage'] }> {
  let priorRequestId: string | null = null;
  const requestUrl = buildChatCompletionsUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const data = await withRetry<OpenAICompatibleResponse>(async (attemptSignal) => {
    let response: Response;
    try {
      response = await fetchImpl(requestUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
          ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: 0.3,
          max_tokens: 4096,
        }),
        signal: attemptSignal,
      });
    } catch (networkError: unknown) {
      throw classifyOpenAICompatibleError({ cause: networkError, providerName: options.providerName });
    }

    const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
    if (requestId) {
      priorRequestId = requestId;
    } else {
      logger.debug('SDK', `${options.providerName} response missing request-id header; retry dedup is best-effort`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyOpenAICompatibleError({
        status: response.status,
        bodyText: errorText,
        headers: response.headers,
        cause: new Error(`${options.providerName} API error: ${response.status} - ${errorText}`),
        ...(requestId ? { requestId } : {}),
        providerName: options.providerName,
      });
    }

    const responseData = await response.json() as OpenAICompatibleResponse;

    if (responseData.error) {
      throw classifyOpenAICompatibleError({
        status: response.status,
        bodyText: `${responseData.error.code} ${responseData.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`${options.providerName} API error: ${responseData.error.code} - ${responseData.error.message}`),
        providerName: options.providerName,
      });
    }

    return responseData;
  }, { label: `${options.providerName} ${options.model}` });

  if (!data.choices?.[0]?.message?.content) {
    logger.error('SDK', `Empty response from ${options.providerName}`);
    return { content: '' };
  }

  return {
    content: data.choices[0].message.content,
    tokensUsed: data.usage?.total_tokens,
    usage: data.usage,
  };
}

export class OpenRouterProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = getSelectedOpenAICompatibleConfig();
    const { apiKey, model, providerName } = config;

    if (!apiKey || (config.providerId === 'openai-compatible' && (!config.baseUrl || !config.model))) {
      throw new Error(`${providerName} not fully configured. ${getOpenAICompatibleApiKeyHint(config.providerId)}`);
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `${config.providerId}-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${providerName}`);
    }

    const mode = ModeManager.getInstance().getActiveMode();

    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryOpenAICompatibleMultiTurn(session.conversationHistory, config);
      await this.handleInitResponse(initResponse, session, worker, model, providerName);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', `${providerName} init failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${providerName} init failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, providerName, worker);
      return;
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, config, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', `${providerName} message processing failed`, { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', `${providerName} message processing failed with non-Error`, { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, providerName, worker);
      return;
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', `${providerName} agent completed`, {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model
    });
  }

  private prepareMessageMetadata(session: ActiveSession, message: { agentId?: string | null; agentType?: string | null }): void {
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  private async handleInitResponse(
    initResponse: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string,
    providerName: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, providerName, undefined, model
      );
    } else {
      logger.error('SDK', `Empty ${providerName} init response - session may lack context`, {
        sessionId: session.sessionDbId, model
      });
    }
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type: 'observation' | 'summarize'; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    config: OpenAICompatibleConfig,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(
        session, message, originalTimestamp, lastCwd,
        config, worker, mode
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        config, worker, mode
      );
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    config: OpenAICompatibleConfig,
    worker: WorkerRef | undefined,
    _mode: ModeConfig
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryOpenAICompatibleMultiTurn(session.conversationHistory, config);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      obsResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, config.providerName, lastCwd, config.model
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    config: OpenAICompatibleConfig,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryOpenAICompatibleMultiTurn(session.conversationHistory, config);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      summaryResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, config.providerName, lastCwd, config.model
    );
  }

  private async handleSessionError(error: unknown, session: ActiveSession, providerName: string, _worker?: WorkerRef): Promise<never> {
    if (isAbortError(error)) {
      logger.warn('SDK', `${providerName} agent aborted`, { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', `${providerName} agent error`, { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const config = getSelectedOpenAICompatibleConfig();
    const MAX_CONTEXT_MESSAGES = config.maxContextMessages;
    const MAX_ESTIMATED_TOKENS = config.maxEstimatedTokens;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  private async queryOpenAICompatibleMultiTurn(
    history: ConversationMessage[],
    config: OpenAICompatibleConfig
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying ${config.providerName} multi-turn (${config.model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    const data = await queryOpenAICompatibleChatCompletion({
      providerName: config.providerName,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages,
      headers: config.headers,
    });

    const content = data.content;
    const tokensUsed = data.tokensUsed;

    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', `${config.providerName} API usage`, {
        model: config.model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }
}

export function isOpenRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY'));
}

export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}

export function getSelectedOpenAICompatibleProviderId(): OpenAICompatibleProviderId {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const provider = settings.CLAUDE_MEM_PROVIDER;
  if (provider === 'openai-compatible' || provider === 'opencode-go' || provider === 'openrouter') {
    return provider;
  }
  return 'openrouter';
}

export function isOpenAICompatibleSelected(): boolean {
  const provider = getSelectedOpenAICompatibleProviderId();
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === provider;
}

export function isOpenAICompatibleAvailable(): boolean {
  const provider = getSelectedOpenAICompatibleProviderId();
  if (provider === 'openrouter') {
    return isOpenRouterAvailable();
  }
  const config = getSelectedOpenAICompatibleConfig();
  if (provider === 'openai-compatible') {
    return !!(config.apiKey && config.baseUrl && config.model);
  }
  return !!config.apiKey;
}

export function getOpenAICompatibleApiKeyHint(providerId: OpenAICompatibleProviderId): string {
  if (providerId === 'openrouter') {
    return 'Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY in ~/.claude-mem/.env.';
  }
  if (providerId === 'opencode-go') {
    return 'Set CLAUDE_MEM_OPENCODE_GO_API_KEY in settings or OPENCODE_GO_API_KEY in ~/.claude-mem/.env.';
  }
  return 'Set CLAUDE_MEM_OPENAI_COMPAT_API_KEY, CLAUDE_MEM_OPENAI_COMPAT_BASE_URL, and CLAUDE_MEM_OPENAI_COMPAT_MODEL in settings.';
}

export function getSelectedOpenAICompatibleConfig(): OpenAICompatibleConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const provider = getSelectedOpenAICompatibleProviderId();

  if (provider === 'opencode-go') {
    return {
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      apiKey: settings.CLAUDE_MEM_OPENCODE_GO_API_KEY || getCredential('OPENCODE_GO_API_KEY') || '',
      model: settings.CLAUDE_MEM_OPENCODE_GO_MODEL || 'deepseek-v4-flash',
      baseUrl: settings.CLAUDE_MEM_OPENCODE_GO_BASE_URL || OPENCODE_GO_BASE_URL,
      headers: parseOpenAICompatibleHeaders(settings.CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON),
      maxContextMessages: parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES,
      maxEstimatedTokens: parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS,
    };
  }

  if (provider === 'openai-compatible') {
    return {
      providerId: 'openai-compatible',
      providerName: settings.CLAUDE_MEM_OPENAI_COMPAT_PROVIDER_NAME || 'OpenAI-compatible provider',
      apiKey: settings.CLAUDE_MEM_OPENAI_COMPAT_API_KEY || '',
      model: settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL || '',
      baseUrl: settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL || '',
      headers: parseOpenAICompatibleHeaders(settings.CLAUDE_MEM_OPENAI_COMPAT_HEADERS_JSON),
      maxContextMessages: parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES,
      maxEstimatedTokens: parseInt(settings.CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS,
    };
  }

  const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
  const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';
  return {
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    apiKey: settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '',
    model: settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free',
    baseUrl: OPENROUTER_BASE_URL,
    headers: {
      'HTTP-Referer': siteUrl || 'https://github.com/thedotmack/claude-mem',
      'X-Title': appName || 'claude-mem',
    },
    maxContextMessages: parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES,
    maxEstimatedTokens: parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS,
  };
}
