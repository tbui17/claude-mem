import { describe, it, expect } from "bun:test";
import {
  ClaudeMemPlugin,
  parseSearchResponse,
  REGISTERED_OPENCODE_HOOKS,
  REAL_OPENCODE_EVENT_TYPES,
} from "../../src/integrations/opencode-plugin/index";
import { PluginNotifier } from "../../src/integrations/opencode-plugin/logger";

/**
 * Regression guard for plan-08 (OpenCode event-contract correctness).
 *
 * The old plugin subscribed to bus event names that do not exist in OpenCode
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`,
 * `session.deleted` on a `(name, payload)` switch) and parsed `data.items`
 * instead of the worker's real `data.content` blocks — so it captured nothing
 * and search always returned "No results". These tests fail CI if either
 * contract regresses.
 */

// The real OpenCode plugin hook names. Anything the plugin returns as a hook
// key must be in this allowlist; a future typo (e.g. "session.created") fails.
const REAL_OPENCODE_HOOK_NAMES = new Set<string>([
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "tool.execute.before",
  "permission.ask",
  "auth",
  "config",
  // `tool` is the custom-tool registration map, part of the plugin return shape.
  "tool",
]);

// Bus event names the old code used that DO NOT exist in OpenCode's contract.
const PHANTOM_BUS_EVENT_NAMES = [
  "session.created",
  "message.updated",
  "session.compacted",
  "file.edited",
];

const pluginCtx = {
  client: {},
  project: { name: "test-project", path: "/tmp/x" },
  directory: "/tmp/x",
  worktree: "/tmp/x",
  serverUrl: new URL("http://127.0.0.1:1234"),
  $: {},
};

function createFetchRecorder(responseFactory?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const posts: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = String(url);
    posts.push({
      url: stringUrl,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return responseFactory?.(stringUrl, init) ?? new Response(JSON.stringify({ status: "queued" }), { status: 200 });
  }) as typeof fetch;

  return {
    posts,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function createOpenCodeClientRecorder() {
  const logs: Array<{
    body: {
      service: "claude-mem";
      level: string;
      message: string;
      extra?: Record<string, unknown>;
    };
  }> = [];
  const toasts: Array<{
    body: {
      title: string;
      message: string;
      variant: string;
      duration?: number;
      directory?: string;
    };
  }> = [];

  return {
    logs,
    toasts,
    client: {
      app: {
        log: (input: (typeof logs)[number]) => {
          logs.push(input);
        },
      },
      tui: {
        showToast: (input: (typeof toasts)[number]) => {
          toasts.push(input);
        },
      },
    },
  };
}

function withConsoleErrorRecorder() {
  const calls: unknown[][] = [];
  const originalError = globalThis.console.error;
  globalThis.console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  return {
    calls,
    restore: () => {
      globalThis.console.error = originalError;
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("OpenCode plugin event contract", () => {
  it("only registers hooks that are part of OpenCode's real contract", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);

    for (const key of hookKeys) {
      expect(
        REAL_OPENCODE_HOOK_NAMES.has(key),
        `hook "${key}" is not a real OpenCode hook name`,
      ).toBe(true);
    }

    // The exported allowlist of hooks we bind to must itself be real.
    for (const hook of REGISTERED_OPENCODE_HOOKS) {
      expect(REAL_OPENCODE_HOOK_NAMES.has(hook)).toBe(true);
    }

    // The capture-critical hooks must be present.
    expect(hookKeys).toContain("tool.execute.after");
    expect(hookKeys).toContain("chat.message");
    expect(hookKeys).toContain("experimental.session.compacting");
    expect(hookKeys).toContain("event");
  });

  it("does not register the phantom bus event names as hooks", async () => {
    const plugin = await ClaudeMemPlugin(pluginCtx);
    const hookKeys = Object.keys(plugin);
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(hookKeys).not.toContain(phantom);
    }
  });

  it("only reacts to real bus event types", () => {
    // session.idle / session.deleted are real OpenCode bus events; the phantom
    // names must never appear in the reacted-to allowlist.
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.idle");
    expect(REAL_OPENCODE_EVENT_TYPES).toContain("session.deleted");
    for (const phantom of PHANTOM_BUS_EVENT_NAMES) {
      expect(REAL_OPENCODE_EVENT_TYPES as readonly string[]).not.toContain(phantom);
    }
  });

  it("posts observations to the worker via tool.execute.after and toasts the full output.args input", async () => {
    const { posts, restore } = createFetchRecorder();
    const { client, toasts } = createOpenCodeClientRecorder();

    try {
      const plugin = await ClaudeMemPlugin({ ...pluginCtx, client });
      const toolAfter = plugin["tool.execute.after"];
      const toolArgs = { path: "/a", nested: { keep: true }, count: 3 };
      await toolAfter(
        { tool: "read", sessionID: "ses_tool_toast", callID: "c1" },
        { title: "Read", output: "file contents", metadata: {}, args: toolArgs },
      );

      const initPost = posts.find((p) => p.url.includes("/api/sessions/init"));
      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(initPost, "tool.execute.after should lazily init the session").toBeTruthy();
      expect(obsPost, "tool.execute.after should POST an observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("read");
      expect(obsBody.tool_input).toEqual(toolArgs);
      expect(obsBody.tool_response).toBe("file contents");
      expect(toasts).toHaveLength(1);
      expect(toasts[0].body.message).toBe(JSON.stringify(toolArgs, null, 2));
      expect(toasts[0].body.variant).toBe("success");
      expect(toasts[0].body.duration).toBe(2500);
      expect(toasts[0].body.directory).toBe("/tmp/x");
    } finally {
      restore();
    }
  });

  it("posts assistant chat observations and success toasts from output.parts text", async () => {
    const { posts, restore } = createFetchRecorder();
    const { client, toasts } = createOpenCodeClientRecorder();
    const capturedMessage = "First assistant paragraph.\nSecond assistant paragraph.";

    try {
      const plugin = await ClaudeMemPlugin({ ...pluginCtx, client });
      const chatMessage = plugin["chat.message"];
      await chatMessage(
        {},
        {
          message: { id: "msg_1", role: "assistant", sessionID: "ses_chat_toast" },
          parts: [
            { type: "text", text: "First assistant paragraph." },
            { type: "tool", text: "ignored" },
            { type: "text", text: "Second assistant paragraph." },
          ],
        },
      );

      const obsPost = posts.find((p) => p.url.includes("/api/sessions/observations"));
      expect(obsPost, "chat.message should POST an assistant observation").toBeTruthy();
      const obsBody = obsPost!.body as Record<string, unknown>;
      expect(obsBody.tool_name).toBe("assistant_message");
      expect(obsBody.tool_response).toBe(capturedMessage);
      expect(toasts).toHaveLength(1);
      expect(toasts[0].body.message).toBe(capturedMessage);
      expect(toasts[0].body.variant).toBe("success");
      expect(toasts[0].body.duration).toBe(2500);
      expect(toasts[0].body.directory).toBe("/tmp/x");
    } finally {
      restore();
    }
  });

  it("shows a warning toast when claude_mem_search cannot reach the worker", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { client, toasts } = createOpenCodeClientRecorder();

    try {
      const plugin = await ClaudeMemPlugin({ ...pluginCtx, client });
      const result = await plugin.tool.claude_mem_search.execute({ query: "auth" });

      expect(result).toContain("claude-mem worker is not running");
      expect(toasts).toHaveLength(1);
      expect(toasts[0].body.message).toContain("npx claude-mem start");
      expect(toasts[0].body.variant).toBe("warning");
      expect(toasts[0].body.directory).toBe("/tmp/x");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("PluginNotifier OpenCode logging and toast contract", () => {
  it("logs through client.app.log and sends toasts directly through client.tui.showToast", () => {
    const { client, logs, toasts } = createOpenCodeClientRecorder();
    const notifier = new PluginNotifier(client, "/workspace/project");

    notifier.warn("worker slow", { retry: true });
    notifier.toast({
      title: "Memory saved",
      message: "Captured read output",
      variant: "success",
      duration: 2500,
      extra: { tool: "read" },
    });

    expect(logs[0]).toEqual({
      body: {
        service: "claude-mem",
        level: "warn",
        message: "worker slow",
        extra: { retry: true },
      },
    });
    expect(logs[1].body).toMatchObject({
      service: "claude-mem",
      level: "info",
      message: "OpenCode toast attempted",
      extra: {
        title: "Memory saved",
        message: "Captured read output",
        variant: "success",
        duration: 2500,
        directory: "/workspace/project",
        tool: "read",
      },
    });
    expect(toasts).toEqual([
      {
        body: {
          title: "Memory saved",
          message: "Captured read output",
          variant: "success",
          duration: 2500,
          directory: "/workspace/project",
        },
      },
    ]);
  });

  it("queues rapid consecutive toasts and displays them one at a time", async () => {
    const { client, toasts } = createOpenCodeClientRecorder();
    const notifier = new PluginNotifier(client, "/workspace/project");

    notifier.toast({
      title: "First",
      message: "Captured first output",
      variant: "success",
      duration: 1,
    });
    notifier.toast({
      title: "Second",
      message: "Captured second output",
      variant: "success",
      duration: 1,
    });

    expect(toasts.map((toast) => toast.body.title)).toEqual(["First"]);
    await delay(175);
    expect(toasts.map((toast) => toast.body.title)).toEqual(["First", "Second"]);
  });

  it("waits the toast duration plus buffer before displaying the next toast", async () => {
    const { client, toasts } = createOpenCodeClientRecorder();
    const notifier = new PluginNotifier(client, "/workspace/project");

    notifier.toast({
      title: "Longer",
      message: "Visible longer",
      variant: "info",
      duration: 50,
    });
    notifier.toast({
      title: "After buffer",
      message: "Shown after the buffer",
      variant: "success",
      duration: 1,
    });

    await delay(120);
    expect(toasts.map((toast) => toast.body.title)).toEqual(["Longer"]);
    await delay(100);
    expect(toasts.map((toast) => toast.body.title)).toEqual(["Longer", "After buffer"]);
  });

  it("continues draining the queue after showToast rejects", async () => {
    const consoleError = withConsoleErrorRecorder();
    const logs: unknown[] = [];
    const toasts: Array<{ body: { title: string; message: string; variant: string; duration?: number; directory?: string } }> = [];
    let calls = 0;
    const notifier = new PluginNotifier(
      {
        app: { log: (input: unknown) => logs.push(input) },
        tui: {
          showToast: (input: (typeof toasts)[number]) => {
            calls += 1;
            if (calls === 1) {
              return Promise.reject(new Error("async boom"));
            }
            toasts.push(input);
          },
        },
      },
      "/workspace/project",
    );

    try {
      notifier.toast({ title: "Rejects", message: "First", variant: "error", duration: 1 });
      notifier.toast({ title: "Continues", message: "Second", variant: "success", duration: 1 });

      await delay(175);

      expect(calls).toBe(2);
      expect(toasts.map((toast) => toast.body.title)).toEqual(["Continues"]);
      expect(logs).toHaveLength(2);
      expect(consoleError.calls.some((call) => String(call[0]).includes("OpenCode TUI toast failed"))).toBe(true);
    } finally {
      consoleError.restore();
    }
  });

  it("logs unavailable showToast fallback errors and keeps draining the queue", async () => {
    const consoleError = withConsoleErrorRecorder();
    const logs: unknown[] = [];
    const notifier = new PluginNotifier(
      {
        app: {
          log: (input: unknown) => logs.push(input),
        },
        tui: {},
      },
      "/workspace/project",
    );

    try {
      expect(() => {
        notifier.toast({ title: "One", message: "First", variant: "info", duration: 1 });
        notifier.toast({ title: "Two", message: "Second", variant: "success", duration: 1 });
      }).not.toThrow();

      expect(logs).toHaveLength(1);
      expect(consoleError.calls).toHaveLength(1);
      await delay(175);
      expect(logs).toHaveLength(2);
      expect(consoleError.calls).toHaveLength(2);
      expect(String(consoleError.calls[0][0])).toContain("OpenCode TUI toast API is unavailable");
    } finally {
      consoleError.restore();
    }
  });

  it("drops the oldest info toast first when the pending queue is full", () => {
    const { client, logs, toasts } = createOpenCodeClientRecorder();
    const notifier = new PluginNotifier(client, "/workspace/project");

    notifier.toast({ title: "Active", message: "First", variant: "success", duration: 1000 });
    notifier.toast({ title: "Queued success", message: "Second", variant: "success", duration: 1 });
    for (let index = 0; index < 10; index += 1) {
      notifier.toast({ title: `Queued info ${index}`, message: "Info", variant: "info", duration: 1 });
    }

    expect(toasts.map((toast) => toast.body.title)).toEqual(["Active"]);
    expect(logs.some((log) => log.body.message === "OpenCode toast dropped from full queue")).toBe(true);
    const dropLog = logs.find((log) => log.body.message === "OpenCode toast dropped from full queue");
    expect(dropLog?.body.extra).toMatchObject({ title: "Queued info 0", variant: "info" });
  });

  it("logs every toast attempt and reports a clear unavailable-toast message", () => {
    const logs: unknown[] = [];
    const consoleError = withConsoleErrorRecorder();
    const notifier = new PluginNotifier(
      {
        app: {
          log: (input: unknown) => logs.push(input),
        },
      },
      "/workspace/project",
    );

    try {
      expect(() =>
        notifier.toast({
          title: "Memory saved",
          message: "Captured read output",
          variant: "success",
        }),
      ).not.toThrow();

      expect(logs).toHaveLength(1);
      expect(consoleError.calls).toHaveLength(1);
      expect(String(consoleError.calls[0][0])).toContain("OpenCode TUI toast API is unavailable");
      expect(String(consoleError.calls[0][0])).toContain("toast was not shown");
    } finally {
      consoleError.restore();
    }
  });

  it("treats toast failures as best-effort and does not throw", async () => {
    const consoleError = withConsoleErrorRecorder();
    const app = { log: () => undefined };
    const throwingNotifier = new PluginNotifier({ app, tui: { showToast: () => { throw new Error("boom"); } } });
    const rejectingNotifier = new PluginNotifier({ app, tui: { showToast: () => Promise.reject(new Error("async boom")) } });

    try {
      expect(() =>
        throwingNotifier.toast({
          title: "Memory saved",
          message: "Captured read output",
          variant: "success",
        }),
      ).not.toThrow();
      expect(() =>
        rejectingNotifier.toast({
          title: "Memory saved",
          message: "Captured read output",
          variant: "success",
        }),
      ).not.toThrow();
      await Promise.resolve();

      expect(consoleError.calls.some((call) => String(call[0]).includes("OpenCode TUI toast failed"))).toBe(true);
    } finally {
      consoleError.restore();
    }
  });
});

describe("OpenCode search client response-shape contract", () => {
  it("parses the worker's real data.content blocks and returns the rows", () => {
    // This is exactly what SearchManager.searchObservations returns on a hit.
    const workerResponse = JSON.stringify({
      content: [
        {
          type: "text",
          text:
            'Found 2 observation(s) matching "auth"\n\n| # | Title |\n|---|---|\n1. Added login flow\n2. Fixed token refresh',
        },
      ],
    });

    const rendered = parseSearchResponse(workerResponse, "auth");
    expect(rendered).toContain("Found 2 observation(s)");
    expect(rendered).toContain("Added login flow");
    expect(rendered).toContain("Fixed token refresh");
    expect(rendered).not.toContain("No results");
  });

  it("does NOT parse the old data.items shape (regression guard)", () => {
    // The pre-fix worker contract was wrongly assumed to be { items: [...] }.
    // A client that still reads data.items would render rows here; the real
    // client reads data.content, so this is correctly reported as no results.
    const oldShape = JSON.stringify({
      items: [{ title: "should-not-render" }, { title: "also-not" }],
    });
    const rendered = parseSearchResponse(oldShape, "auth");
    expect(rendered).toContain("No results");
    expect(rendered).not.toContain("should-not-render");
  });

  it("returns a clear no-results message for the worker's empty-content shape", () => {
    const emptyResponse = JSON.stringify({
      content: [{ type: "text", text: 'No observations found matching "zzz"' }],
    });
    const rendered = parseSearchResponse(emptyResponse, "zzz");
    expect(rendered).toContain("No observations found");
  });
});
