# Paired OpenCode benchmarks

Each arm gets a fresh copy of the same source, a separate OpenCode profile and one continuous session. The runner submits the same prompts in the same order and waits for each turn to finish. Trial order alternates. Native compaction and model output limits use stock OpenCode 2.2.6 defaults.

| Suite | Workload | Independent acceptance |
| --- | --- | --- |
| `short` | Six sequential JavaScript programming exercises | Six Node test cases with additional assertions |
| `semver` | A range-diagnostics feature on the public `semver` 7.7.2 package | Eight tests, including a compatibility matrix, plus a final recall of an earlier requirement |
| `aider` | 150 exercises from Aider Polyglot `7e0611e` | Original exercise tests in five language runtimes |

The Aider suite interleaves the first 30 alphabetical exercises in Python, Go, JavaScript, Rust, and Java in that order. The grader overlays only declared solution files on pristine exercise copies and enables the tests that Exercism initially skips. Each live arm gets one continuous session. The Aider arms start in parallel. [Pinned exercise set](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e)

Use `node benchmarks/run.ts` with the same flags if PowerShell intercepts npm’s argument separator.

## Preflight

The short and SemVer suites are the default pair. Preflight exercises the fixture and acceptance harness without inference. Provide the pinned archive as `--semver-tarball` for a fully offline preflight.

```sh
npm run benchmark -- --preflight
```

For Aider, provide the unpacked pinned revision, a Python with pytest, a tools directory containing `go/bin/go` and JUnit Platform Console 1.10.0 plus AssertJ 3.25.1, and a `node_modules` directory with Jest 29.7 and the Exercism Babel preset. Java and Cargo must be on PATH. Point `--python` at the absolute path to the pytest environment's interpreter.

```sh
npm run benchmark -- --preflight --suite aider --aider-fixture-dir /path/to/polyglot-benchmark --aider-tools-dir /path/to/tools --aider-js-dir /path/to/node_modules --python /path/to/python
```

## Metered runs

Build the plugin and install stock `@opencode/cli@2.2.6` first. Use `--opencode-bin` or `OPENCODE_BIN` when the executable is outside PATH. Select the model, the environment variable holding the provider key, a combined estimated spend cap and an amount to reserve before admitting each stage. The runner adds the credential through the official SDK and removes the isolated profile after the arm. Provider costs arrive after requests settle, so a stage can consume more than its reserve. Apply an account-level cap when a hard spending limit is required. The runner accepts `--trials 1` for one pair and defaults to three.

```sh
npm run build
npm run benchmark -- --live --suite aider --parallel --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.35 --trials 1 --aider-fixture-dir /path/to/polyglot-benchmark --aider-tools-dir /path/to/tools --aider-js-dir /path/to/node_modules --python /path/to/python
```

Each `result.json` in `.runs/live-*/` includes independent grades, the model's advertised pricing and limits, OpenCode's estimated USD, uncached input, cache reads and writes, output and reasoning, observed request counts, measured primary prompt sizes, plugin cuts and time, recovery telemetry and native compaction timing. Prompt sizes use reported primary request input plus cache reads and writes. Observed request counts are a lower bound because stock telemetry does not expose every physical retry or background request. Exact recovery is verified in the stock integration test. The live runner records whether recalls succeed when the agent chooses to call the tool. [OpenCode client and events](https://opencode.ai/docs/build/client/)

`comparison.json` contains paired differences and reports whether both candidates passed. Timing uses the host's compaction start and terminal events. Confirmed Live Compact replacement windows have a separate count and host wait total. Local replacement processing time comes from the plugin diagnostics. An unmarked model-driven compaction still counts as native work, including a manual fallback in the treatment arm. The report also includes combined host wait for both kinds of compaction. If the stock arm never compacts automatically or a timing event is missing, the pause and wait differences are inconclusive. Treat a smaller context or reduced estimated API spend as beneficial only when both candidates meet the same correctness checks.

## Run Aider in Daytona

Use a persistent Linux sandbox and set its auto-stop interval to `0` so the run can continue after you disconnect. Daytona bills sandbox compute separately from model API usage. [Daytona lifecycle settings](https://www.daytona.io/docs/en/sandboxes/#automated-lifecycle-management)

Prepare a checkout in the sandbox with Node.js 22.18 or newer. Install dependencies with `npm ci`, build the plugin with `npm run build`, and install stock OpenCode 2.2.6. Set `OPENAI_API_KEY` in the sandbox environment. Follow the [Aider benchmark instructions](README.md) for the pinned fixtures and test runtimes. Warm the Cargo cache for the Rust exercise and reference manifests. Include RxJava 2.2.12 and Reactive Streams 1.0.2 for Java Hangman.

On your laptop, install and authenticate the Daytona CLI or set `DAYTONA_API_KEY` and `DAYTONA_API_URL` in the project `.env`. Run the benchmark with `--target daytona`. All tool and fixture paths below are sandbox paths. Use `--target local` or omit `--target` to run locally.

```sh
npm run benchmark -- --target daytona --live --suite aider --trials 1 \
  --model openai/gpt-6-luna --key-env OPENAI_API_KEY --budget-usd 15 --reserve-usd 0.75 \
  --opencode-bin /path/to/opencode --aider-fixture-dir /path/to/polyglot-benchmark \
  --aider-tools-dir /path/to/tools --aider-js-dir /path/to/node_modules \
  --python /path/to/venv/bin/python
```

The default sandbox is `Benchmark-sandbox` and the default remote checkout is `~/benchmark-progress/cloud/repo`. Override them with `--daytona-sandbox` and `--daytona-project-dir`.

Watch live grades from the sandbox terminal.

```sh
tail -n +1 -F ~/benchmark-progress/latest/progress.jsonl |
  node ~/benchmark-progress/cloud/repo/benchmarks/run.ts --format-progress
```

`~/benchmark-progress/latest/benchmark.log` prints the run directory. When the arms finish, open `comparison.json` and `comparison-1.md` there.
