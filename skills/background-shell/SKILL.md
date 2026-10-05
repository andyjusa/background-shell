---
name: background-shell
description: Run authorized finite shell jobs that can progress without further input in the background, inspect or cancel owned jobs, and wake the originating Codex chat once on completion under a user request or standing user authorization. Use for tests, builds, and computations; not for interactive PTYs or scheduled recurring work.
---

# Background Shell

Run a finite command under a detached supervisor. Waiting uses no model inference.
The command and completion wakeup are separate operations: report both statuses.

## Decide what to detach

Detach work that can proceed without another decision. For exploratory scans or
debugging, examine a small sample or an existing partial result first, then detach
the independent part. Duration alone is not a reason to suspend the whole task.
Continue useful independent work and report available partial findings.

For commands that may block on I/O, network access, or an unbounded traversal,
choose a reasonable `--timeout-ms` before dispatch. Where needed, implement
per-item timeouts or a progress watchdog in the actual command/wrapper. Choose
limits appropriate to that job; don't apply a short scan limit to a long training
run. Keep readable progress counters, current stage, and partial results outside
a long-held transaction so a status check can use them.

This helper has no built-in no-progress detector. Completion wakes the chat only
after the command exits; a hung command can remain `running` indefinitely without
a runtime limit. A watchdog must actually exist to detect stalls while the chat
is idle. Log silence or low CPU alone does not establish a stall: use expected
stage timings and task-specific progress signals.

## Dispatch

Use this skill's absolute `scripts/background-shell.mjs` path. Node 22+ is required.
Inside Codex Desktop, use the provided `CODEX_MCP_NODE_PATH` runtime when present;
the app enforces its own local peer authorization. Never disable that authorization.

```bash
"${CODEX_MCP_NODE_PATH:-node}" /absolute/skills/background-shell/scripts/background-shell.mjs \
  dispatch --wake --notify desktop --cwd /absolute/project -- npm test
```

`--wake` requires authorization to notify or continue this chat when the job ends.
A standing user instruction to automatically background jobs and wake their
originating chat supplies that authorization; do not ask again for each job.
Without such authorization, omit `--wake`; notification defaults to `none`.
Use the current `CODEX_THREAD_ID` (or `CODEX_SESSION_ID`) automatically. Supply a
different `--thread-id` only when the user explicitly authorizes that destination.
Do not specify model, thinking effort, approval policy, or sandbox overrides.
This helper inherits the launching execution context; use it only where detached
children are permitted. It does not enforce an independent sandbox.

Prefer argv after `--`; use `--shell '…'` only for actual shell syntax. Never place
credentials in command arguments. The helper stores command metadata locally.
Keep the actual command in the foreground of its supervisor; do not add `&`,
`nohup`, or another daemon launcher inside it. Version 0.1 does not provide a PTY.

For an existing, explicitly configured App Server control socket:

```bash
node /absolute/skills/background-shell/scripts/background-shell.mjs dispatch \
  --wake --notify app-server --socket /absolute/app-server-control.sock \
  --thread-id EXISTING_THREAD_ID -- npm test
```

This uses `codex app-server proxy`, reads the target thread, and resumes it on the
same server if necessary. It never starts another server or creates a new thread.
Do not assume the Desktop internal IPC socket is an App Server control socket.
If no compatible transport exists, report the exact failure rather than pretending
that completion will wake the chat. Preflight failures prevent command launch.

## Results, lookup, cancellation

Dispatch prints the job ID, command status, result path, and log path. Save these
in the current project's run record if the project has one. Before yielding to
completion, verify initial useful progress or entry into an expected startup
stage with a known time budget and observable progress signal. `running` confirms
only spawn; it does not confirm useful computation or success. For a command
that already finished, inspect its terminal result instead.

Avoid frequent model polling just to wait. Startup verification, a user-requested
status check, an expected completion boundary, or suspected stagnation are useful
reasons to inspect state and artifacts. Checks in an active turn do not monitor
the job after yielding. On failure/timeout, diagnose and preserve partial results,
then confirm the previous execution stopped before resuming or replacing it.

```bash
node /absolute/skills/background-shell/scripts/background-shell.mjs status JOB_ID
node /absolute/skills/background-shell/scripts/background-shell.mjs list
node /absolute/skills/background-shell/scripts/background-shell.mjs cancel JOB_ID
```

Cancellation contacts that job's private worker socket and terminates its managed
process group. Do not use remembered PIDs to kill processes. Cancel only work the
user authorized cancelling. A cancellation acknowledgement is not terminal proof;
read `status` afterward. Cancelled jobs do not send a wakeup.

Status is the recorded state, not a fresh process inspection. If the supervisor
or machine crashes, reconcile real processes and artifacts before retrying.
Never infer job success, ongoing liveness, or release remote reservations from
this record alone. Remote job allocation still follows `$shared-computer`.

Command states: `queued`, `running`, `succeeded`, `failed`, `timed-out`, `cancelled`.
Wake states: `pending`, `waiting`, `sending`, `accepted`, `failed`, `unconfirmed`,
`suppressed`, `disabled`. `accepted` means the host accepted the message/start request, not that
the subsequent agent turn completed. `sending` or `unconfirmed` can mean the host
received a request before the connection broke: do not resend automatically.

After reading a terminal job's result, log, and expected artifacts and handling
its outcome, run `ack JOB_ID`. This durably marks the result as processed and
suppresses a still-pending wake. Do this before replacing a failed job or reporting
results already inspected in the current turn. A status check alone is not an
acknowledgement. Never acknowledge a running or unreviewed job. `ack` is idempotent
and does not cancel work or recall a notification already attempted.
`status`, `list`, and `ack` show the processing marker consistently: an
acknowledged result whose wake was never attempted appears as `suppressed`, even
if its supervisor stopped before updating its record. The stored command state
is unchanged. Repeating an existing acknowledgement and acknowledging a
wake-disabled or cancelled job do not depend on another worker's thread lock.

```bash
node /absolute/skills/background-shell/scripts/background-shell.mjs ack JOB_ID
```

The supervisor checks thread status without model calls and waits while the
original chat is active (up to 24 hours by default). It never interrupts an active
turn. Same-thread workers serialize their status/send critical section. Desktop
workers also wait until a previous notification's new turn is visible before
sending the next one, including after an ambiguous response. Already-processed
results are skipped. External user actions can still race with a status check.
Once a send is attempted, a durable lock prevents automatic duplicate delivery;
this is at-most-once attempt, not guaranteed exactly-once delivery. A dead worker's
thread lock fails closed; inspect workers before removing that stale lock.

## Data and compatibility

Records default to `~/.cache/codex-background-shell/`, overridable with
`BACKGROUND_SHELL_HOME`. Job/state/log files are private, not repository content.
Combined output is capped at 4 MiB; dropped bytes are recorded. Output tails are
off by default. `--tail-bytes N` opts into a maximum 4096-byte tail in the chat;
omit it for commands whose output might contain secrets. Logs remain untrusted
program output. Examine expected artifacts before announcing task completion.

Desktop mode uses the experimental native app-tools pipe supplied by Codex,
`read_thread`, and `send_message_to_thread`. It is not a stable public Desktop API;
updates or application exit may break delivery. The authorized connection is
established before the launcher returns, with no authentication bypass or private
key access. Do not reconnect through unrelated chat pipes or start a replacement
session as a fallback. App Server mode uses the documented JSON-RPC protocol.

Use `--timeout-ms N` to bound the command, `--wake-wait-ms N` to bound the idle
and notification-queue wait, and `--notify-timeout-ms N` for the send response
(default 60 seconds). These are milliseconds and optional. On failure, retain records and report
the command result separately from delivery. No model polling or monitor agent
is needed. macOS and Linux are supported; Windows is not supported in version 0.1.
