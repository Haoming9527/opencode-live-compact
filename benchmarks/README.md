# Run the four benchmarks

Every live command compares **Original OpenCode** with **Live Compact**, using the same model and ordered prompts, separate workspaces, and one continuous session per version. Both keep stock OpenCode **2.2.6** compaction and output defaults.

| Suite | What it runs | Acceptance checks |
| --- | --- | --- |
| [1. Short](#1-short) | 6 small JavaScript tasks | 6 tests |
| [2. SemVer](#2-semver) | 10 stages developing a SemVer feature | 8 tests and a requirement-retention check |
| [3. Aider](#3-aider) | 150 programming exercises across five languages | Complete exercise tests; target 150/150 |
| [4. Web-Bench React](#4-web-bench-react) | 20 dependent tasks building one React app | Cumulative browser tests; 59 cases at task 20 |

**Preflight** checks fixtures and tests without model calls. **Live** runs the paid comparison, repeating preflight before making model calls. Fixture and dependency downloads can still require network access.

Use an explicit suite name: `--suite all` currently runs **Short and SemVer only**, not all four.

## Setup once

Run commands from this repository's root. Use Node.js **22.18 or newer** and install stock OpenCode **2.2.6** for live runs.

```sh
npm ci
npm run build
opencode --version
```

For local paid runs, put your existing `OPENAI_API_KEY` in the project's ignored `.env`. The commands below use `node --env-file=.env` to load it. If the key is already exported in your shell, omit `--env-file=.env`. Preflight needs no API key.

The examples run **one pair**, with both versions in parallel. The `$15` budget is combined across the two versions **for that command**, not across all four suites. Change `--budget-usd` as needed. `--reserve-usd 0.75` reserves room before another model attempt; it is not a fee or a hard billing limit.

Commands are single lines so they can be pasted into PowerShell or a Linux shell. Replace `/path/to/...` with installed fixture paths. If OpenCode is outside PATH, append `--opencode-bin /path/to/opencode` to a live command.

## 1. Short

No external fixture setup is needed.

**Preflight:**

```sh
node benchmarks/run.ts --preflight --suite short
```

**Run both versions:**

```sh
node --env-file=.env benchmarks/run.ts --live --suite short --parallel --trials 1 --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.75
```

## 2. SemVer

Requires `tar` on PATH. The runner downloads and integrity-checks SemVer **7.7.2**. To use an existing archive, append `--semver-tarball /path/to/semver-7.7.2.tgz` to either command.

**Preflight:**

```sh
node benchmarks/run.ts --preflight --suite semver
```

**Run both versions:**

```sh
node --env-file=.env benchmarks/run.ts --live --suite semver --parallel --trials 1 --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.75
```

## 3. Aider

Prepare [Aider Polyglot at `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f) and its test runtimes first:

| Argument / requirement | What to provide |
| --- | --- |
| `--aider-fixture-dir` | Root of the pinned Polyglot checkout |
| `--aider-tools-dir` | Directory containing `go/bin/go`, JUnit Platform Console 1.10.0, AssertJ 3.25.1, RxJava 2.2.12, and Reactive Streams 1.0.2 jars |
| `--aider-js-dir` | `node_modules` containing Jest 29.7 and the Exercism Babel preset |
| `--python` | Absolute path to a Python interpreter with pytest installed |
| PATH / dependency cache | Java and Cargo available; Rust dependencies cached for offline tests and Go dependencies available locally |

**Preflight — require the reference to pass all 150 exercises:**

```sh
node benchmarks/run.ts --preflight --suite aider --aider-fixture-dir /path/to/polyglot --aider-tools-dir /path/to/tools --aider-js-dir /path/to/js/node_modules --python /path/to/python
```

**Run both versions:**

```sh
node --env-file=.env benchmarks/run.ts --live --suite aider --parallel --trials 1 --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.75 --max-attempts 3 --aider-fixture-dir /path/to/polyglot --aider-tools-dir /path/to/tools --aider-js-dir /path/to/js/node_modules --python /path/to/python
```

The runner interleaves the first 30 alphabetical exercises in Python, Go, JavaScript, Rust, and Java. It enables supplied skipped tests and grades only candidate solution files against pristine tests. Both versions get the same self-test command and up to three attempts per exercise, including the first attempt. All repairs count toward cost and time.

## 4. Web-Bench React

Prepare a clean [Web-Bench checkout at `7b31ca2b786eef120dd49ce63dd03d0c0006046d`](https://github.com/bytedance/web-bench/tree/7b31ca2b786eef120dd49ce63dd03d0c0006046d). Install React and `@web-bench/test-util` dependencies using pnpm **8.15.8** and `common/config/rush/pnpm-lock.yaml`; the root lockfile is unrelated. Install Playwright **1.57.0**'s matching Chromium headless shell. Keep the benchmark's Apache-2.0 license with its fixtures.

| Argument | What to provide |
| --- | --- |
| `--webbench-fixture-dir` | Clean pinned Git checkout, with `projects/react/node_modules` installed |
| `--webbench-browsers-dir` | Playwright browser cache containing the matching Chromium installation |

**Preflight — require the reference to pass 59/59 twice:**

```sh
node benchmarks/run.ts --preflight --suite webbench --webbench-fixture-dir /path/to/web-bench --webbench-browsers-dir /path/to/playwright-browsers
```

**Run both versions:**

```sh
node --env-file=.env benchmarks/run.ts --live --suite webbench --parallel --trials 1 --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.75 --max-attempts 3 --timeout-minutes 30 --webbench-fixture-dir /path/to/web-bench --webbench-browsers-dir /path/to/playwright-browsers
```

Preflight also requires the starter and a deliberately broken reference to fail real assertions. Each live stage runs tests for tasks 1 through the current task, with one browser worker, no test retries, and separate ports. Each version gets up to three model attempts per stage. Candidate `src/` files are graded in fresh copies with pristine tests and configuration.

Reports distinguish stages passed within the attempt limit from the final application's cumulative test results. This is an adapted Web-Bench protocol, not an official leaderboard score. See [the workload and validation details](long-tasks.md).

## Run any suite in Daytona

Prepare the repository, dependencies, stock OpenCode, and the chosen fixtures **inside the sandbox**. Its environment must already contain `OPENAI_API_KEY`. Configure the sandbox to stay running if you want to close your laptop.

From your laptop, install the Daytona CLI and put `DAYTONA_API_KEY` and `DAYTONA_API_URL` in the local `.env`. Take one of the commands above, omit `--env-file=.env`, and append:

```text
--target daytona --daytona-sandbox Benchmark-sandbox-8gb --daytona-project-dir /path/to/remote/repo --wait-for-slot
```

All fixture, browser, Python, and OpenCode paths must then be **sandbox paths**. The launcher loads local Daytona authentication; the model key stays in the sandbox. `--wait-for-slot` waits behind an existing benchmark. The versions within a pair still run in parallel.

For example, this queues a Short preflight using the prepared Web-Bench checkout:

```sh
node benchmarks/run.ts --preflight --suite short --target daytona --daytona-sandbox Benchmark-sandbox-8gb --daytona-project-dir /home/daytona/benchmark-progress/webbench/repo --wait-for-slot
```

The launcher prints its `benchmark.log` and `progress.jsonl` paths. While queued, read the printed **benchmark.log** path. `latest` switches to the new job only when it acquires the slot; `progress.jsonl` is created when a live run begins.

## See progress and results

| Location | Contents |
| --- | --- |
| `benchmark.log` in the Daytona launch folder | Queue status, preflight output, errors, and the run artifacts directory |
| `progress.jsonl` | Aider / Web-Bench stage pass/fail counts and cumulative estimated cost together on one line |
| `.runs/live-*/comparison.json` | Paired results for every suite |
| `.runs/live-*/comparison-1.md` | English comparison tables for Aider and Web-Bench |
| Each version's `result.json` and `grade.tap` | Usage, timing, independent grades, and test output |

For an active Aider or Web-Bench run, open the sandbox terminal:

```sh
tail -n +1 -F ~/benchmark-progress/latest/progress.jsonl
```

For Short or SemVer, watch `benchmark.log`; these suites grade at the end and do not emit per-exercise progress lines. They also do not use the staged repair loop. Every suite retains results when tests fail and exits unsuccessfully if either version misses its acceptance target.

Costs include model attempts and repairs and are OpenCode estimates, not billing receipts. Daytona compute is separate. Reports separate cached input, uncached input, cache writes, native compaction pauses, Live Compact cuts, and host wait time. If Original OpenCode never compacts automatically, or timing telemetry is incomplete, the pause comparison is **inconclusive**. Smaller prompts alone do not prove lower cost or preserved correctness.
