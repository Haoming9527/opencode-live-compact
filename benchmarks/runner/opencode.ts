import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import type { OpenCodeClient } from "@opencode/client";

const inherited = ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"];

export function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(inherited.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
}

function stockBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  if (process.platform !== "win32") return "opencode";
  const npmBinary = join(dirname(process.execPath), "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  if (existsSync(npmBinary)) return npmBinary;
  return "opencode.exe";
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const closed = once(probe, "close");
  probe.close();
  await closed;
  if (!address || typeof address === "string") throw new Error("No loopback port available");
  return address.port;
}

export async function startOpenCode(options: {
  binary?: string;
  directory: string;
  profile: string;
  signal?: AbortSignal;
  offline?: boolean;
  toolPaths?: string[];
}) {
  const { directory, profile, signal } = options;
  signal?.throwIfAborted();
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const port = await availablePort();
  const password = randomBytes(32).toString("base64url");
  const log = join(profile, `server-${port}.log`);
  const handle = await open(log, "wx", 0o600);
  const env = {
    ...commandEnvironment(),
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_DATA_HOME: join(profile, "data"),
    XDG_STATE_HOME: join(profile, "state"),
    XDG_CACHE_HOME: join(profile, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_PASSWORD: password,
    ...(options.toolPaths ? { PATH: [...options.toolPaths, process.env.PATH ?? ""].join(delimiter) } : {}),
    ...(options.offline ? { OPENCODE_DISABLE_MODELS_FETCH: "1" } : {}),
  };
  const binary = options.binary ?? stockBinary();
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ["ignore", handle.fd, handle.fd],
  });
  let launchError: Error | undefined;
  child.on("error", error => { launchError = error; });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  await handle.close();
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill();
    await exited;
  };
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
  try {
    const until = Date.now() + 30_000;
    for (;;) {
      signal?.throwIfAborted();
      if (launchError) throw new Error(`Cannot launch ${binary}: ${launchError.message}`);
      if (child.exitCode !== null || Date.now() >= until) throw new Error(`OpenCode startup failed. See ${log}`);
      const info = await client.server.info({ signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
      if (info) {
        if (info.pid !== child.pid) throw new Error("Unexpected OpenCode process owns the benchmark port");
        if (info.version !== "2.2.6") throw new Error(`OpenCode 2.2.6 is required. Found ${info.version}`);
        return { client, close };
      }
      await delay(150, undefined, { signal });
    }
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitForTurn(client: OpenCodeClient, sessionID: string, previousIdle: number | undefined, signal: AbortSignal) {
  for (;;) {
    const state = await client.session.get({ sessionID }, { signal });
    if (state.time.idle !== undefined && state.time.idle !== previousIdle && state.outcome !== undefined &&
        state.time.idle >= (state.time.busy ?? 0)) return state;
    await delay(200, undefined, { signal });
  }
}
