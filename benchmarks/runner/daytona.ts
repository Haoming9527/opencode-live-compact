import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function launchDaytona(sandbox: string, directory: string, args: string[]) {
  let fileEnv: NodeJS.ProcessEnv = {};
  try {
    fileEnv = parseEnv(readFileSync(".env", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Use the existing Daytona authentication without passing the model key to the CLI.
  const env = { ...process.env };
  for (const name of ["DAYTONA_API_KEY", "DAYTONA_API_URL"]) {
    env[name] ??= fileEnv[name];
  }
  if (!env.DAYTONA_API_URL || env.DAYTONA_API_URL === "https://api.daytona.ai/v1") {
    env.DAYTONA_API_URL = "https://app.daytona.io/api";
  }
  delete env.OPENAI_API_KEY;

  const script = [
    "set -euo pipefail",
    "umask 077",
    'cd -- "$1"',
    "shift",
    'test -f benchmarks/run.ts || { echo "Benchmark checkout is missing in the sandbox" >&2; exit 1; }',
    'root="$HOME/benchmark-progress"',
    'mkdir -p "$root"',
    'launch=$(mktemp -d "$root/aider-XXXXXX")',
    'export OPENCODE_BENCHMARK_PROGRESS_FILE="$launch/progress.jsonl"',
    'nohup flock -n "$root/.benchmark.lock" node benchmarks/run.ts "$@" > "$launch/benchmark.log" 2>&1 </dev/null &',
    'pid=$!',
    'printf "%s\\n" "$pid" > "$launch/pid"',
    "sleep 1",
    'if ! kill -0 "$pid" 2>/dev/null; then cat "$launch/benchmark.log" >&2; echo "Benchmark did not start or another run holds the lock" >&2; exit 1; fi',
    'ln -sfnT -- "$launch" "$root/latest"',
    'printf "Benchmark log: %s/benchmark.log\\nProgress: %s/progress.jsonl\\n" "$launch" "$launch"',
  ].join("\n");
  const checkout = directory.startsWith("~/") ? '"$HOME"/' + quote(directory.slice(2)) : quote(directory);
  const command = ["bash", "-c", quote(script), "benchmark", checkout, ...args.map(quote)].join(" ");
  const result = spawnSync("daytona", ["exec", sandbox, "--", command], { env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Daytona benchmark launch failed");
}
