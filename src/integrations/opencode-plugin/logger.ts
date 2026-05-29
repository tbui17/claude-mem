type AppLogLevel = "info" | "warn" | "error";
type LoggerLevel = "debug" | AppLogLevel;

interface AppLogEntry {
  body: {
    service: "claude-mem";
    level: AppLogLevel;
    message: string;
    extra?: unknown;
  };
}

interface ToastParameters {
  title?: string;
  message: string;
  variant: "info" | "success" | "warning" | "error";
  duration?: number;
  directory?: string;
}

interface OpenCodeClientLike {
  app?: {
    log?: (entry: AppLogEntry) => Promise<unknown> | unknown;
  };
  tui?: {
    showToast?: (parameters: ToastParameters) => Promise<void> | void;
  };
}

export interface PluginLogSink {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export interface PluginNotifierOptions {
  client?: unknown;
  directory?: string;
  context?: string;
  now?: () => number;
}

function asOpenCodeClient(client: unknown): OpenCodeClientLike | undefined {
  return client && typeof client === "object" ? (client as OpenCodeClientLike) : undefined;
}

function fallbackConsole(level: LoggerLevel, message: string, extra?: unknown): void {
  const prefix = `[claude-mem] ${message}`;
  const args = extra === undefined ? [prefix] : [prefix, extra];
  if (level === "error") {
    globalThis.console.error(...args);
  } else if (level === "warn") {
    globalThis.console.warn(...args);
  } else {
    globalThis.console.info(...args);
  }
}

export class PluginNotifier implements PluginLogSink {
  private readonly client?: OpenCodeClientLike;
  private readonly directory?: string;
  private readonly context: string;
  private readonly now: () => number;
  private readonly cooldowns = new Map<string, number>();

  constructor(options: PluginNotifierOptions = {}) {
    this.client = asOpenCodeClient(options.client);
    this.directory = options.directory;
    this.context = options.context ?? "CLAUDE_MEM";
    this.now = options.now ?? Date.now;
  }

  debug(message: string, extra?: unknown): void {
    this.appLog("debug", message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.appLog("info", message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.appLog("warn", message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.appLog("error", message, extra);
  }

  toast(input: {
    title?: string;
    message: string;
    variant: "info" | "success" | "warning" | "error";
    duration?: number;
    cooldownKey?: string;
    cooldownMs?: number;
  }): void {
    const cooldownKey = input.cooldownKey;
    if (cooldownKey) {
      const existing = this.cooldowns.get(cooldownKey);
      const current = this.now();
      if (existing !== undefined && current < existing) return;
      if (input.cooldownMs !== undefined) {
        this.cooldowns.set(cooldownKey, current + input.cooldownMs);
      }
    }

    const showToast = this.client?.tui?.showToast;
    if (!showToast) return;
    try {
      const result = showToast({
        title: input.title,
        message: input.message,
        variant: input.variant,
        duration: input.duration,
        directory: this.directory,
      });
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Toasts are best-effort and should never affect plugin hooks.
    }
  }

  private appLog(level: LoggerLevel, message: string, extra?: unknown): void {
    const app = this.client?.app;
    const appLog = app?.log;
    const appLevel: AppLogLevel = level === "debug" ? "info" : level;
    const formattedMessage = `[${this.context}] ${message}`;

    if (!appLog) {
      fallbackConsole(level, formattedMessage, extra);
      return;
    }

    try {
      const result = appLog.call(app, {
        body: {
          service: "claude-mem",
          level: appLevel,
          message: formattedMessage,
          extra,
        },
      });
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((error) => {
          fallbackConsole("warn", `OpenCode app.log failed for: ${formattedMessage}`, error);
        });
      }
    } catch (error) {
      fallbackConsole("warn", `OpenCode app.log failed for: ${formattedMessage}`, error);
    }
  }
}

export const fallbackLogger: PluginLogSink = new PluginNotifier();
