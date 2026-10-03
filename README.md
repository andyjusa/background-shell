# Codex Background Shell

Run a finite shell command in the background and wake its original Codex chat
when it finishes. Inspired by Pi interactive-shell's dispatch workflow, written
independently with Node built-ins and no runtime packages.

대기 중 모델 호출 없이 셸 작업을 실행하고, 완료 시 원래 Codex 채팅을 깨웁니다.

## Install the global skill

Requires Node.js 22+, macOS or Linux. Install the `skills/background-shell` folder
in `${CODEX_HOME:-$HOME/.codex}/skills/background-shell`, or use the Codex skill
installer with this repository and path `skills/background-shell`.

```sh
git clone https://github.com/andyjusa/background-shell.git
node background-shell/install.mjs
```

The installer refuses to overwrite an existing skill. It changes no global
AGENTS.md, MCP settings, approval policies, login configuration, or services.
The skill becomes discoverable on the next Codex turn.

## Codex Desktop

Ask Codex: “Use $background-shell to run the tests in the background and notify
this chat when they finish.” In a shell tool launched by Desktop:

```sh
"${CODEX_MCP_NODE_PATH:-node}" "$HOME/.codex/skills/background-shell/scripts/background-shell.mjs" \
  dispatch --wake --notify desktop --cwd /absolute/project -- npm test
```

The original thread ID and app-tools pipe come from the executor environment.
Desktop mode uses the installed host's experimental native app-tools protocol.
It requires `read_thread` and `send_message_to_thread`. The private transport
is **not a supported public Desktop API** and compatibility may change between
releases. It obeys the existing socket peer authorization, retaining an authorized
connection from launch to delivery; it does not read credentials or weaken checks.
Do not run it from an unrelated external terminal with guessed socket paths.

## Existing Codex App Server

For a server you already run with a supported Unix control socket:

```sh
node skills/background-shell/scripts/background-shell.mjs dispatch \
  --wake --notify app-server --socket /absolute/app-server-control.sock \
  --thread-id EXISTING_THREAD_ID -- npm test
```

This connects using `codex app-server proxy`, initializes JSON-RPC, checks the
thread's status, waits for idle, and supplies standalone tool output to `turn/start`.
No new server, new thread, or second CLI `exec resume` is launched. The socket
must belong to the server managing the target thread. The Desktop IPC socket is
not interchangeable with this socket.

Official protocol: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Job lifecycle

One detached supervisor per job owns one command process group, output collection,
and the completion connection. Dispatch returns after command spawn is observed.
No always-on daemon, monitoring agent, or model inference is used while waiting.
Starting the agent's continuation does use the normal model and account limits.

```sh
node skills/background-shell/scripts/background-shell.mjs dispatch -- npm test
node skills/background-shell/scripts/background-shell.mjs dispatch --timeout-ms 600000 --shell 'npm run build && npm test'
node skills/background-shell/scripts/background-shell.mjs status JOB_ID
node skills/background-shell/scripts/background-shell.mjs ack JOB_ID
node skills/background-shell/scripts/background-shell.mjs cancel JOB_ID
node skills/background-shell/scripts/background-shell.mjs list
```

- Wakeups require `--wake` and the user's authorization to notify/continue that chat.
- Wake transports are preflighted before executing the command.
- The supervisor waits for idle instead of interrupting the active turn. Default
  idle-wait deadline: 24 hours, adjustable with `--wake-wait-ms`.
- Same-thread workers serialize status checks and send requests. Desktop workers
  wait for the preceding notification's continuation to become visible before
  sending another, so delayed turn startup cannot cause a simultaneous burst.
- After inspecting a terminal result and handling its outcome, use `ack JOB_ID`.
  Pending notifications are suppressed, including while a chat is busy. Merely
  reading status does not acknowledge it; `ack` cannot recall an attempted send.
- Send responses have a separate 60-second timeout, configurable with
  `--notify-timeout-ms`. Ambiguous responses are never automatically retried.
- A dead worker's notification lock fails closed with an explicit error. Inspect
  the processes and recorded attempts before removing a stale lock.
- Success, nonzero exit, spawn failure, and timeout are reported distinctly.
- Cancellation contacts a private Unix socket, terminates the managed process
  group (TERM, then KILL after 1.5 seconds), and suppresses completion messages.
- A permanent send-attempt lock prevents automatic resend after ambiguous results.
  Delivery is **at-most-once attempt**, not guaranteed exactly-once. If the app
  exits, the connection closes, or an acknowledgement is lost, delivery can fail.
- Recorded status is not a fresh OS process inspection. There is no crash/reboot
  recovery or automatic job replay. Reconcile stale jobs before rerunning anything.
- Commands must remain foreground children; don't daemonize them with `&` or
  `nohup`. No interactive PTY, regex monitor, remote scheduler, or Windows support.

## Progress and stalls

Detach finite work that can continue without further decisions. Exploratory scans
benefit from a small sample or partial result before a full traversal. Confirm
initial progress or an expected startup stage before leaving the job to run;
`running` confirms process spawn only.

For potentially blocking work, set a reasonable `--timeout-ms`. It defaults to
zero (no runtime limit). Per-item timeouts and no-progress detection belong in the
command or a job-specific wrapper; this helper does not provide a stall detector.
A hung command won't send a completion wakeup until it exits or times out. Keep
readable progress and partial results, and use meaningful stage timings instead
of assuming that silence means failure. Startup/status checks are appropriate;
frequent model polling is unnecessary. A check made before yielding cannot detect
a later stall while the chat is idle.

## Privacy and execution permissions

Job records and capped combined stdout/stderr live under
`~/.cache/codex-background-shell` (or `BACKGROUND_SHELL_HOME`). New directories
are mode 0700; files are 0600. Logs contain at most the first 4 MiB; dropped bytes
are counted. Tail output is not sent to chat by default. Opt in with
`--tail-bytes 4096` only when the output is safe to share. Control characters are
removed, but this is **not secret redaction**.

The helper inherits the launching executor environment and runs with its OS
permissions. It does not provide or bypass a sandbox. Use only authorized commands
where detached children are permitted. Do not put credentials in argv. Local
records may contain private command arguments and output; never commit them.

## Verification

```sh
npm test
```

The 28 tests passed locally, including a two-worker Desktop mock with delayed
turn startup. Tests run real detached commands to check survival after dispatch exits, exit codes, spawn
errors, cancellation of descendants, timeouts, private records, and bounded logs.
Mock host tests cover idle waiting, at-most-once attempts, acknowledgement loss,
transport framing, retained Desktop connections, and App Server request shape.
Regression tests cover processed-result suppression, acknowledgement during idle
waiting, concurrent notification serialization, delayed turn visibility,
independent threads, and preservation of older send-attempt records.

A live smoke test on macOS with Codex Desktop's 0.159.2 runtime confirmed command
completion, waiting while the original chat was active, an accepted completion
message after it became idle, and an actual agent continuation in that same chat.
A second live Desktop test with version 0.2.0 confirmed that acknowledging a
completed command while its chat was busy suppresses the pending notification
and lets the supervisor exit without sending a message.

This does not prove compatibility with every Codex release. App Server mode has
mock protocol coverage; it has not been verified against a live App Server here.

## License

MIT. Unofficial community integration; not an OpenAI product.
