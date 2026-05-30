import { z } from "zod";
import { PluginNotifier, type PluginLogSink } from "./logger";
import { ensureWorkerReady, resolveWorkerPort, type WorkerHealth } from "./worker-manager";
interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface SessionCompactingOutput {
  context: string[];
  prompt?: string;
}

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<string>;
}

interface OpenCodeEventInput {
  event: {
    type: string;
    properties: Record<string, unknown>;
  };
}

let _worker: WorkerHealth | null = null;
let _workerInitPromise: Promise<WorkerHealth | null> | null = null;

/**
 * Lazy worker init — discovers or starts the worker, caches the result.
 * First call may spawn a new worker process or kill zombie sockets.
 */
function ensureWorkerInitialized(logger: PluginLogSink): Promise<WorkerHealth | null> {
  if (_workerInitPromise === null) {
    _workerInitPromise = ensureWorkerReady(undefined, logger).then((w) => {
      _worker = w;
      return w;
    });
  }
  return _workerInitPromise;
}

function workerBaseUrl(): string {
  const port = _worker?.port ?? resolveWorkerPort();
  return `http://127.0.0.1:${port}`;
}

const MAX_TOOL_RESPONSE_LENGTH = 1000;

const MAX_SESSION_MAP_ENTRIES = 1000;
const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogSink,
): void {
  logger.debug(`POST ${path} → ${workerBaseUrl()}${path}`);
  fetch(`${workerBaseUrl()}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })
    .then((response) => {
      logger.debug(`POST ${path} → ${response.status} ${response.statusText}`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ECONNREFUSED")) {
        logger.warn(`Worker POST ${path} failed: ${message}`);
      }
    });
}

async function workerGetText(path: string, logger: PluginLogSink): Promise<string | null> {
  try {
    const response = await fetch(`${workerBaseUrl()}${path}`, { headers: JSON_HEADERS });
    if (!response.ok) {
      logger.warn(`Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      logger.warn(`Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

function formatToastInput(input: unknown): string {
  try {
    if (typeof input === "string") return input;
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";
  const notifier = new PluginNotifier({
    client: ctx.client,
    directory: ctx.directory,
  });

  notifier.info(`OpenCode plugin loading (project: ${projectName})`);

  // Per-plugin-instance state. Keeping these inside the factory closure (rather
  // than at module scope) gives each `ClaudeMemPlugin(ctx)` call a fresh map/set,
  // which keeps the idempotency guards (no double `/api/sessions/init`, no double
  // `/api/sessions/summarize`) provable from unit tests that re-instantiate the
  // plugin in `beforeEach` instead of having to hand-clear module globals.
  const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
  const initializedSessions = new Set<string>();

  function getOrCreateContentSessionId(openCodeSessionId: string): string {
    if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
      while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
        const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
        if (oldestKey !== undefined) {
          contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
          initializedSessions.delete(oldestKey);
        } else {
          break;
        }
      }
      contentSessionIdsByOpenCodeSessionId.set(
        openCodeSessionId,
        `opencode-${openCodeSessionId}-${Date.now()}`,
      );
    }
    return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
  }

  function ensureSessionInitialized(openCodeSessionId: string): string {
    const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
    if (!initializedSessions.has(openCodeSessionId)) {
      initializedSessions.add(openCodeSessionId);
      workerPostFireAndForget("/api/sessions/init", {
        contentSessionId,
        project: projectName,
        prompt: "",
      }, notifier);
    }
    return contentSessionId;
  }

  function toastObservationCaptured(toolName: string, toolInput: unknown): void {
    notifier.toast({
      title: "claude-mem observation captured",
      message: `${toolName} input: ${formatToastInput(toolInput)}`,
      variant: "success",
      duration: 2500,
    });
  }

  return {
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      notifier.debug(`tool.execute.after called: tool=${input?.tool}, sessionID=${input?.sessionID}`);
      // Without this guard a sessionless tool call would key the session map
      // on the literal string "undefined" and collapse every sessionless
      // observation into one phantom `opencode-undefined-<ts>` session
      // (claude-mem#2503 P1 follow-up review).
      if (!input?.sessionID) return;
      const contentSessionId = ensureSessionInitialized(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      }, notifier);
      toastObservationCaptured(input.tool, input.args || {});
    },

    "chat.message": async (input: ChatMessageInput): Promise<void> => {
      if (!input?.sessionID) return;
      ensureSessionInitialized(input.sessionID);
    },

    "experimental.session.compacting": async (
      input: SessionCompactingInput,
      _output: SessionCompactingOutput,
    ): Promise<void> => {
      if (!input?.sessionID) return;
      // Lazy-init only. The summarize POST is intentionally NOT fired here —
      // OpenCode emits the matching `session.compacted` event after compaction
      // completes, and that branch (below) owns the single summarize call.
      // Posting from both signals would double-write the summary row per
      // compaction cycle (claude-mem#2503 P1 review).
      ensureSessionInitialized(input.sessionID);
    },

    event: async (eventInput: OpenCodeEventInput): Promise<void> => {
      const e = eventInput?.event;
      if (!e || typeof e.type !== "string") return;
      const props = (e.properties || {}) as Record<string, unknown>;

      switch (e.type) {
        case "session.created": {
          const sid = (props.info as { id?: string } | undefined)?.id;
          if (sid) ensureSessionInitialized(sid);
          // Proactive worker init — triggers recovery/startup in background
          // so it's ready before the first search or observation
          ensureWorkerInitialized(notifier)
            .then((worker) => {
              if (!worker) return;
              notifier.toast({
                title: "claude-mem worker ready",
                message: `Memory capture is available on port ${worker.port}.`,
                variant: "success",
                cooldownKey: "worker-ready",
                cooldownMs: 10_000,
              });
            })
            .catch((error: unknown) => {
              notifier.warn("Worker initialization failed", error instanceof Error ? error.message : String(error));
              notifier.toast({
                title: "claude-mem worker unavailable",
                message: "Memory capture is disabled until the worker responds.",
                variant: "warning",
                cooldownKey: "worker-init-failed",
                cooldownMs: 10_000,
              });
            });
          break;
        }

        case "message.updated": {
          const info = props.info as
            | { role?: string; sessionID?: string; content?: unknown }
            | undefined;
          if (!info || info.role !== "assistant" || !info.sessionID) break;
          const contentSessionId = ensureSessionInitialized(info.sessionID);
          const text = typeof info.content === "string" ? info.content : "";
          workerPostFireAndForget("/api/sessions/observations", {
            contentSessionId,
            tool_name: "assistant_message",
            tool_input: info.content ?? {},
            tool_response: truncate(text),
            cwd: ctx.directory,
          }, notifier);
          toastObservationCaptured("assistant_message", info.content);
          break;
        }

        case "session.compacted": {
          const sid = props.sessionID as string | undefined;
          if (!sid) break;
          const contentSessionId = ensureSessionInitialized(sid);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          }, notifier);
          break;
        }

        case "session.deleted": {
          const sid = (props.info as { id?: string } | undefined)?.id;
          if (sid) {
            contentSessionIdsByOpenCodeSessionId.delete(sid);
            initializedSessions.delete(sid);
          }
          break;
        }
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: z.string().describe("Search query for memory observations"),
        },
        async execute(
          args: Record<string, unknown>,
        ): Promise<string> {
          const query = String(args.query || "");
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
            notifier,
          );

          if (!text) {
            notifier.toast({
              title: "claude-mem worker unavailable",
              message: "Start it with: npx claude-mem start",
              variant: "warning",
              cooldownKey: "worker-unavailable",
              cooldownMs: 10_000,
            });
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          // Worker returns MCP-formatted responses: { content: [{ type: "text", text: "..." }] }
          // Parse the text content directly instead of looking for data.items.
          let data: any;
          try {
            data = JSON.parse(text);
          } catch (error: unknown) {
            notifier.warn("Failed to parse search results", error instanceof Error ? error.message : String(error));
            return "Failed to parse search results.";
          }
          let responseText: string;
          if (data.content && Array.isArray(data.content) && data.content.length > 0) {
            const firstContent = data.content[0];
            responseText = typeof firstContent?.text === "string" ? firstContent.text : "";
          } else if (typeof data.text === "string") {
            responseText = data.text;
          } else {
            responseText = JSON.stringify(data);
          }

          if (!responseText || responseText.includes("No observations found")) {
            return `No results found for "${query}".`;
          }
          return responseText;
        },
      } satisfies ToolDefinition,
    },
  };
};

export default ClaudeMemPlugin;
