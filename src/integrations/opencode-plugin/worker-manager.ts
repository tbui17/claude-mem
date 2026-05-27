import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { probePort } from '../../services/infrastructure/PortProbe.js';

const DEFAULT_WORKER_PORT = 37777;
const KNOWN_WORKER_PORTS = [37780, 37779, 37777];
const WORKER_PORT_SCAN_RADIUS = 5;
const HEALTH_TIMEOUT_MS = 1000;
const AUTOSTART_POLL_INTERVAL_MS = 500;
const AUTOSTART_POLL_MAX_ATTEMPTS = 16;

export interface WorkerDiagnostic {
  workerUrl: string;
  readiness: { ok: boolean; error?: string };
  health: { ok: boolean; status?: unknown; error?: string };
}

export interface WorkerHealth {
  ready: boolean;
  port: number;
}

/**
 * Resolve the configured worker port from env or default.
 */
export function resolveWorkerPort(): number {
  const fromEnv = process.env.CLAUDE_MEM_WORKER_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 77;
  return 37700 + (uid % 100);
}

/**
 * Generate candidate ports to try, starting with the configured port,
 * then known ports, then a +/- radius around the configured port.
 */
export function candidateWorkerPorts(configuredPort: number = DEFAULT_WORKER_PORT): number[] {
  const candidates = new Set<number>([configuredPort, ...KNOWN_WORKER_PORTS]);
  for (let port = configuredPort - WORKER_PORT_SCAN_RADIUS; port <= configuredPort + WORKER_PORT_SCAN_RADIUS; port++) {
    if (port > 0 && port <= 65535) {
      candidates.add(port);
    }
  }
  return [...candidates];
}

/**
 * Quick health check against the worker's /api/health endpoint.
 */
async function healthCheck(port: number, timeoutMs: number = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Try to find a healthy worker on any candidate port.
 * Returns the first port that responds to /api/health.
 */
export async function discoverWorker(configuredPort?: number): Promise<WorkerHealth | null> {
  const ports = candidateWorkerPorts(configuredPort ?? resolveWorkerPort());
  const results = await Promise.all(
    ports.map(async (port) => ({ port, ready: await healthCheck(port) }))
  );
  const healthy = results.find((r) => r.ready);
  return healthy ? { ready: true, port: healthy.port } : null;
}

/**
 * Kill zombie claude-mem worker/chroma processes on Windows.
 * Uses PowerShell to find the root process in each process tree and
 * force-kill the entire tree with `taskkill /T /F`.
 */
async function killWindowsWorkerProcesses(timeoutMs: number): Promise<boolean> {
  const script = `
$patterns = @(
  "\\\\.claude-mem[\\\\/]",
  "worker-service\\.cjs",
  "chroma-mcp"
)
$self = $PID
$matches = Get-CimInstance Win32_Process | Where-Object {
  $cmd = $_.CommandLine
  $name = $_.Name
  $isWorkerService = $cmd -and $cmd -match "worker-service\\.cjs"
  $isChromaSupport = $cmd -and ($cmd -match "\\\\.claude-mem[\\\\/].*chroma" -or $cmd -match "chroma-mcp")
  $isWorkerProcess = $name -in @("bun.exe", "node.exe", "cmd.exe", "uvx.exe", "uv.exe", "chroma-mcp.exe", "python.exe")
  $_.ProcessId -ne $self -and ($isWorkerService -or ($isWorkerProcess -and $isChromaSupport))
}
$roots = $matches | Where-Object {
  $parentPid = $_.ParentProcessId
  -not ($matches | Where-Object { $_.ProcessId -eq $parentPid })
}
foreach ($process in $roots) {
  taskkill /PID $process.ProcessId /T /F | Out-Null
}
$roots | ForEach-Object { $_.ProcessId }
`;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const proc = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      stdio: "ignore",
      windowsHide: true,
    });

    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };

    proc.on("close", (code) => settle(code === 0));
    proc.on("error", () => settle(false));

    setTimeout(() => {
      if (!settled) {
        try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: "ignore" }); } catch { /* ignore */ }
        settle(false);
      }
    }, timeoutMs);
  });
}

/**
 * Kill zombie worker processes on Unix.
 */
async function killUnixWorkerProcesses(timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const proc = spawn("pkill", [
      "-TERM",
      "-f",
      String.raw`\.claude-mem[\/]|worker-service\.cjs|chroma-mcp`,
    ], { stdio: "ignore", windowsHide: true });

    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      resolve(success);
    };

    proc.on("close", (code) => settle(code === 0 || code === 1));
    proc.on("error", () => settle(false));

    setTimeout(() => settle(false), timeoutMs);
  });
}

/**
 * Kill zombie claude-mem processes to clear stuck ports.
 */
export async function recoverWorker(timeoutMs: number = 5000): Promise<boolean> {
  if (process.platform === "win32") {
    return killWindowsWorkerProcesses(timeoutMs);
  }
  return killUnixWorkerProcesses(timeoutMs);
}

/**
 * Spawn the claude-mem worker via `npx claude-mem start`.
 */
function startWorker(actualPort: number): boolean {
  const env = {
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(actualPort),
  };
  try {
    const child = spawn("npx", ["claude-mem", "start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    child.on("error", () => { /* swallow — reported via timeout */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll for a worker to become healthy after starting one.
 */
async function waitForWorker(configuredPort?: number, timeoutMs: number = 8000): Promise<WorkerHealth | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await discoverWorker(configuredPort);
    if (worker) return worker;
    await new Promise((resolve) => setTimeout(resolve, AUTOSTART_POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * Probe candidate ports, skipping zombies (TCP LISTEN with dead PID).
 * Returns the first truly free port, or null if none found.
 */
async function findFreePort(configuredPort: number): Promise<number | null> {
  const candidates = candidateWorkerPorts(configuredPort);
  for (const port of candidates) {
    const { status } = await probePort(port);
    if (status === 'free') return port;
    // status === 'zombie': skip
    // status === 'in_use': skip (discoverWorker would have found it already)
  }
  return null;
}

/**
 * Ensure the claude-mem worker is running and healthy.
 *
 * Strategy:
 * 1. Try to discover a healthy worker on any candidate port
 * 2. If not found, try to kill zombie processes and re-discover
 * 3. If still not found, find a free port (skipping zombies), then spawn
 * 4. Return the first healthy worker, or null if all attempts fail
 */
export async function ensureWorkerReady(configuredPort?: number): Promise<WorkerHealth | null> {
  const port = configuredPort ?? resolveWorkerPort();

  // Step 1: Discover existing worker
  const existing = await discoverWorker(port);
  if (existing) return existing;

  // Step 2: Kill zombie processes and try again
  console.log("[claude-mem] Worker not found, attempting to recover zombie processes...");
  await recoverWorker();
  const afterRecover = await discoverWorker(port);
  if (afterRecover) return afterRecover;

  // Step 3: Find a free port (skipping zombies) then spawn
  const freePort = await findFreePort(port);
  if (freePort === null) {
    console.warn("[claude-mem] No free port available — all candidates are occupied");
    return null;
  }

  console.log(`[claude-mem] Starting claude-mem worker on port ${freePort}...`);
  const started = startWorker(freePort);
  if (!started) {
    console.warn("[claude-mem] Failed to start worker via npx");
    return null;
  }

  // Step 4: Wait for the worker to become healthy
  const spawned = await waitForWorker(freePort);
  if (spawned) {
    console.log(`[claude-mem] Worker started on port ${spawned.port}`);
    return spawned;
  }

  console.warn("[claude-mem] Worker failed to become healthy within timeout");
  return null;
}
