type AppLogLevel = "info" | "warn" | "error";
export type PluginLogLevel = "debug" | AppLogLevel;

export type ToastVariant = "success" | "warning" | "error" | "info";

interface ToastInput {
  title: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
  directory?: string;
  extra?: Record<string, unknown>;
}

interface QueuedToast extends ToastInput {
  directory?: string;
}

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
  private readonly toastQueue: ToastQueue;

  constructor(
    client: unknown,
    private readonly directory?: string,
  ) {
    super(client);
    this.toastQueue = new ToastQueue(
      (toast) => this.showToastNow(toast),
      (dropped) => this.warn("OpenCode toast dropped from full queue", {
        title: dropped.title,
        message: dropped.message,
        variant: dropped.variant,
        duration: dropped.duration,
        directory: dropped.directory,
      }),
    );
  }

  toast(input: ToastInput): void {
    const { title, message, variant, duration, directory, extra } = input;
    const toastDirectory = directory ?? this.directory;

    try {
      this.toastQueue.enqueue({
        title,
        message,
        variant,
        duration,
        directory: toastDirectory,
        extra,
      });
    } catch (error: unknown) {
      globalThis.console.error("[claude-mem] OpenCode TUI toast enqueue failed:", formatError(error));
    }
  }

  private async showToastNow(input: QueuedToast): Promise<void> {
    const { title, message, variant, duration, directory, extra } = input;

    this.info("OpenCode toast attempted", {
      title,
      message,
      variant,
      duration,
      directory,
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
          directory,
        },
      });
      if (isPromiseLike(result)) {
        await result.catch((error: unknown) => {
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

class ToastQueue {
  private readonly pending: QueuedToast[] = [];
  private draining = false;

  constructor(
    private readonly showToast: (toast: QueuedToast) => Promise<void>,
    private readonly onDrop: (toast: QueuedToast) => void,
  ) {}

  enqueue(toast: QueuedToast): void {
    if (this.pending.length >= 10) {
      const dropIndex = this.pending.findIndex((queued) => queued.variant === "info");
      const [dropped] = this.pending.splice(dropIndex === -1 ? 0 : dropIndex, 1);
      if (dropped) {
        try {
          this.onDrop(dropped);
        } catch (error: unknown) {
          globalThis.console.error(
            "[claude-mem] OpenCode TUI toast drop logging failed:",
            formatError(error),
          );
        }
      }
    }

    this.pending.push(toast);
    if (!this.draining) {
      this.draining = true;
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const toast = this.pending.shift();
      if (!toast) continue;
      await this.showToast(toast);
      await sleep((toast.duration ?? 2500) + 150);
    }
    this.draining = false;
    if (this.pending.length > 0) {
      this.draining = true;
      void this.drain();
    }
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (isObject(timer) && typeof timer.unref === "function") {
      timer.unref();
    }
  });
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
