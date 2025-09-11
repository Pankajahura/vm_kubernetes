// ssh.ts
import net from "node:net";
import  execa  from "execa";

export type SSHOpts = {
  user: string;
  host: string;
  key: string;
  timeoutMs?: number; // total process timeout
};

function baseSshArgs({ user, host, key }: SSHOpts): string[] {
  return [
    "-i",
    key,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    `${user}@${host}`,
  ];
}

/**
 * Execute a command on a remote host via SSH.
 * Always resolves to { stdout, stderr }. Throws on non-zero exit.
 */
export async function sshExec(
  cmd: string,
  opts: SSHOpts
): Promise<{ stdout: string; stderr: string }> {
  const args = [...baseSshArgs(opts), cmd];
  const { stdout, stderr } = await execa("ssh", args, {
    timeout: opts.timeoutMs ?? 120_000,
  });
  return { stdout, stderr };
}

/**
 * Wait until SSH is usable: port 22 is open AND a trivial remote command succeeds.
 * Retries with backoff up to timeoutMs (default 60s).
 */
export async function waitForSSH(
  host: string,
  user: string,
  key: string,
  timeoutMs = 60_000
): Promise<true> {
  const start = Date.now();

  async function portOpen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(5_000);
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("port 22 timeout")));
      socket.connect(22, host, () => {
        socket.end();
        resolve();
      });
    });
  }

  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      // 1) port open?
      await portOpen();
      // 2) can we run a trivial command as the target user?
      await sshExec("true", { user, host, key, timeoutMs: 10_000 });
      return true as const;
    } catch {
      const delay = Math.min(2000 * attempt, 8000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`waitForSSH timed out for ${user}@${host} after ${timeoutMs}ms`);
}
