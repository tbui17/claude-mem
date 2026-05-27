import { execSync } from 'child_process';
import net from 'net';
import { logger } from '../../utils/logger.js';

export type PortStatus = 'free' | 'zombie' | 'in_use';

export interface PortProbeResult {
  status: PortStatus;
  pid?: number;
}

/**
 * Probe a TCP port to determine if it's free, held by a zombie socket
 * (TCP endpoint present but owning process dead), or held by a live
 * process.
 *
 * On Windows this uses Get-NetTCPConnection + Get-Process, because
 * the kernel can orphan TCP endpoints in LISTEN state when the owning
 * process dies without closing them.  A plain HTTP health check or
 * net.createServer().listen() would fail (EADDRINUSE), but the fetch
 * probe returns false negatives.
 *
 * On Unix the kernel cleans up TCP state on process exit, so the
 * simple net.createServer() bind test is sufficient: EADDRINUSE always
 * means a live owner.
 */
export async function probePort(port: number): Promise<PortProbeResult> {
  if (process.platform === 'win32') {
    return probePortWindows(port);
  }
  return probePortUnix(port);
}

/**
 * Windows-probe: query the TCP table and cross-check the owning PID
 * against the live process list.
 */
async function probePortWindows(port: number): Promise<PortProbeResult> {
  try {
    // PowerShell: fetch the TCP table entry for this port, then check
    // whether the owning process is still alive.  Format the result as
    // a simple status string that we parse below — no JSON overhead.
    const script =
      `$c = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue ` +
      `| Select-Object -First 1; ` +
      `if (-not $c) { 'free' } else { ` +
      `  $ownerPid = $c.OwningProcess; ` +
      `  $p = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue; ` +
      `  if ($p) { 'in_use:' + $ownerPid } else { 'zombie:' + $ownerPid } ` +
      `}`;

    const output = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${script}"`,
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    ).trim();

    if (output === 'free') return { status: 'free' };

    const colon = output.indexOf(':');
    if (colon > 0) {
      const tag = output.substring(0, colon);
      const pid = parseInt(output.substring(colon + 1), 10);
      const result: PortProbeResult = {
        status: tag === 'in_use' ? 'in_use' : 'zombie',
        ...(isNaN(pid) ? {} : { pid }),
      };
      return result;
    }

    // Unexpected output format — assume free to be safe.
    return { status: 'free' };
  } catch (error) {
    logger.warn('PORTPROBE', `Windows probe failed for port ${port}, assuming free`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'free' };
  }
}

/**
 * Unix-probe: net.createServer() handles EADDRINUSE natively.  The
 * kernel guarantees that a dead process's sockets are cleaned up, so
 * if the port is bound the owner is alive.
 */
function probePortUnix(port: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ status: 'in_use' });
      } else {
        resolve({ status: 'free' });
      }
    });
    server.once('listening', () => {
      server.close(() => resolve({ status: 'free' }));
    });
    server.listen(port, '127.0.0.1');
  });
}
