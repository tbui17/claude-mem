type AppLogLevel = "info" | "warn" | "error";
export type PluginLogLevel = "debug" | AppLogLevel;

export type ToastVariant = "success" | "warning" | "error" | "info";

interface OpenCodeLogClient {
  app?: {
    log?: (input: {
      body: {
        service: "claude-mem";
        level: AppLogLevel;
        message: string;
        extra?: unknown;
      };
    }) => unknown;
  };
  tui?: {
    showToast?: (input: {
      body: {
        title: string;
        message: string;
        variant: ToastVariant;
        duration?: number;
        directory?: string;
      };
    }) => unknown;
  };
}

export class PluginLogSink {
  constructor(protected readonly client: unknown) {}

  debug(message: string, extra?: unknown): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.log("warn", message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.log("error", message, extra);
  }

  log(level: PluginLogLevel, message: string, extra?: unknown): void {
    const app = this.openCodeClient.app;
    const log = app?.log;
    const appLevel: AppLogLevel = level === "debug" ? "info" : level;
    if (app && typeof log === "function") {
      try {
        const result = log.call(app, {
          body: {
            service: "claude-mem",
            level: appLevel,
            message,
            extra,
          },
        });
        if (isPromiseLike(result)) {
          result.catch((error: unknown) => this.consoleLog(level, message, extra, error));
        }
        return;
      } catch (error: unknown) {
        this.consoleLog(level, message, extra, error);
        return;
      }
    }

    this.consoleLog(level, message, extra);
  }

  private get openCodeClient(): OpenCodeLogClient {
    return isObject(this.client) ? (this.client as OpenCodeLogClient) : {};
  }

  private consoleLog(
    level: PluginLogLevel,
    message: string,
    extra?: unknown,
    logError?: unknown,
  ): void {
    const consoleMethod = level === "debug" ? "log" : level;
    const logger = globalThis.console[consoleMethod] || globalThis.console.log;
    const details = logError === undefined ? extra : { extra, logError: formatError(logError) };
    if (details !== undefined && (!isObject(details) || Object.keys(details).length > 0)) {
      logger.call(globalThis.console, `[claude-mem] ${message}`, details);
      return;
    }
    logger.call(globalThis.console, `[claude-mem] ${message}`);
  }
}

export class PluginNotifier extends PluginLogSink {
  constructor(
    client: unknown,
    private readonly directory?: string,
  ) {
    super(client);
  }

  toast(input: {
    title: string;
    message: string;
    variant: ToastVariant;
    duration?: number;
    directory?: string;
    extra?: Record<string, unknown>;
  }): void {
    const { title, message, variant, duration, directory, extra } = input;
    const toastDirectory = directory ?? this.directory;

    this.info("OpenCode toast attempted", {
      title,
      message,
      variant,
      duration,
      directory: toastDirectory,
      ...extra,
    });

    try {
      if (typeof this.openCodeClientForToast.tui?.showToast !== "function") {
        globalThis.console.error(
          "[claude-mem] OpenCode TUI toast API is unavailable; toast was not shown.",
        );
        return;
      }

      const result = this.openCodeClientForToast.tui.showToast({
        body: {
          title,
          message,
          variant,
          duration,
          directory: toastDirectory,
        },
      });
      if (isPromiseLike(result)) {
        result.catch((error: unknown) => {
          globalThis.console.error(
            "[claude-mem] OpenCode TUI toast failed:",
            formatError(error),
          );
        });
      }
    } catch (error: unknown) {
      globalThis.console.error("[claude-mem] OpenCode TUI toast failed:", formatError(error));
    }
  }

  private get openCodeClientForToast(): OpenCodeLogClient {
    return isObject(this.client) ? (this.client as OpenCodeLogClient) : {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> & { catch: Promise<unknown>["catch"] } {
  return isObject(value) && typeof value.catch === "function";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
