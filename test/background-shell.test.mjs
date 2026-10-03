import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliver, summary, atomicJson } from '../skills/background-shell/scripts/background-shell.mjs';
import { Frames, encodeFrame, Rpc } from '../skills/background-shell/scripts/transport.mjs';

const cli = fileURLToPath(new URL('../skills/background-shell/scripts/background-shell.mjs', import.meta.url));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = file => JSON.parse(fs.readFileSync(file));
function call(home, args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, BACKGROUND_SHELL_HOME: home }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
async function terminal(home, id) {
  const file = path.join(home, id, 'state.json');
  for (let i = 0; i < 250; i++) {
    const state = read(file);
    if (!['queued', 'starting', 'running'].includes(state.status) && state.wake !== 'pending') return state;
    await sleep(20);
  }
  throw new Error('Worker did not finish');
}

test('detached job survives dispatch exit and records output + exit', async t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const start = call(home, ['dispatch', '--', process.execPath, '-e', 'setTimeout(()=>console.log("done"),150)']);
  const end = await terminal(home, start.id);
  assert.equal(end.status, 'succeeded'); assert.equal(end.exitCode, 0); assert.equal(end.wake, 'disabled');
  assert.match(fs.readFileSync(start.logPath, 'utf8'), /done/);
  assert.equal(fs.statSync(start.resultPath).mode & 0o777, 0o600);
});

test('failure and spawn errors are terminal results', async t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bad = call(home, ['dispatch', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal((await terminal(home, bad.id)).exitCode, 7);
  const missing = call(home, ['dispatch', '--', '/nonexistent/background-shell-command']);
  const end = await terminal(home, missing.id);
  assert.equal(end.status, 'failed'); assert.match(end.launchError, /ENOENT/);
});

test('timeout kills a managed process and distinguishes timeout from exit failure', async t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const job = call(home, ['dispatch', '--timeout-ms', '100', '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  const end = await terminal(home, job.id);
  assert.equal(end.status, 'timed-out'); assert.equal(end.signal, 'SIGTERM');
});

test('cancel uses worker control socket, kills descendant group, suppresses wake', async t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pidFile = path.join(home, 'descendant.pid');
  const inner = `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const program = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(inner)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const job = call(home, ['dispatch', '--', process.execPath, '-e', program]);
  let descendant;
  for (let i = 0; i < 100; i++) {
    descendant = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
    if (descendant) break; await sleep(20);
  }
  assert.ok(descendant);
  assert.equal(call(home, ['cancel', job.id]).cancellation, 'accepted');
  const end = await terminal(home, job.id);
  assert.equal(end.status, 'cancelled'); assert.equal(end.wake, 'disabled');
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8' });
  assert.ok(!ps.stdout.trim() || ps.stdout.trim().startsWith('Z'), `Descendant still executing: ${ps.stdout}`);
});

test('logging is capped without blocking a noisy child', async t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const job = call(home, ['dispatch', '--', process.execPath, '-e', 'process.stdout.write("x".repeat(5*1024*1024))']);
  const end = await terminal(home, job.id);
  assert.equal(fs.statSync(job.logPath).size, 4 * 1024 * 1024);
  assert.equal(end.droppedBytes, 1024 * 1024);
});

test('wake requires explicit opt-in; unavailable endpoint prevents command launch', t => {
  const home = temp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const args of [
    ['--notify', 'desktop'],
    ['--wake', '--notify', 'app-server', '--thread-id', 'test', '--socket', '/nonexistent/bs.sock'],
  ]) {
    const r = spawnSync(process.execPath, [cli, 'dispatch', ...args, '--', process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"BAD")', path.join(home, 'marker')], {
      env: { ...process.env, BACKGROUND_SHELL_HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert.notEqual(r.status, 0); assert.equal(fs.existsSync(path.join(home, 'marker')), false);
  }
});

test('reject path traversal and malformed options', () => {
  for (const args of [['status', '../other'], ['dispatch', '--timeout-ms', '-1', '--', 'true'], ['dispatch', '--notify', 'anything', '--', 'true']]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  }
});

test('bounded summary treats logs as untrusted; tails are opt-in', t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'output.log'); fs.writeFileSync(log, 'private text\x1b[31mTAIL');
  const job = { id: 'abc', cwd: dir, tailBytes: 0 };
  assert.doesNotMatch(summary(job, { status: 'succeeded' }, log), /private text/);
  const out = summary({ ...job, tailBytes: 12 }, { status: 'succeeded' }, log);
  assert.match(out, /untrusted/); assert.match(out, /TAIL/); assert.doesNotMatch(out, /\\u001b/);
});

function fakeJob() { return { id: 'abc', notify: 'desktop', cwd: '/', tailBytes: 0, wakeWaitMs: 10 }; }
test('completion waits for idle, sends once, and repeat delivery does not duplicate', async t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let checks = 0, wakes = 0;
  const factory = async () => ({ status: async () => ++checks === 1 ? 'active' : 'idle', wake: async () => wakes++, close() {} });
  const state = { status: 'succeeded', exitCode: 0 };
  await deliver(fakeJob(), dir, state, factory);
  assert.equal(state.wake, 'accepted'); assert.equal(checks, 2);
  await deliver(fakeJob(), dir, state, factory); assert.equal(wakes, 1);
});

test('acknowledgement loss is unconfirmed, never automatically resent', async t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const factory = async () => ({ status: async () => 'idle', wake: async () => { calls++; throw new Error('connection lost'); }, close() {} });
  const state = { status: 'failed', exitCode: 2 };
  await deliver(fakeJob(), dir, state, factory); await deliver(fakeJob(), dir, state, factory);
  assert.equal(state.wake, 'unconfirmed'); assert.equal(calls, 1);
});

test('unknown thread status fails closed without sending', async t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sent = false;
  const state = { status: 'succeeded' };
  await deliver(fakeJob(), dir, state, async () => ({ status: async () => 'unknown', wake: async () => { sent = true; }, close() {} }));
  assert.equal(state.wake, 'failed'); assert.equal(sent, false);
});

test('framing handles split and coalesced frames', () => {
  const frames = new Frames(); const one = encodeFrame({ id: 1, result: 'one' });
  assert.deepEqual(frames.push(one.subarray(0, 2)), []);
  assert.deepEqual(frames.push(Buffer.concat([one.subarray(2), encodeFrame({ id: 2 })])), [{ id: 1, result: 'one' }, { id: 2 }]);
});

test('framing rejects oversized payload and invalid JSON', () => {
  assert.throws(() => new Frames().push(Buffer.from([255, 255, 255, 255])), /too large/);
  const bad = encodeFrame({ id: 1 }); bad[4] = 0;
  assert.throws(() => new Frames().push(bad));
});

test('RPC correlates responses and rejects pending work when transport closes', async () => {
  let request;
  const rpc = new Rpc(m => { request = m; }, () => {}, 100);
  const p = rpc.request('example', {}); rpc.receive({ id: 999, result: 'other' });
  rpc.receive({ id: request.id, result: 'ours' }); assert.equal(await p, 'ours');
  const pending = rpc.request('another', {}); rpc.close(); await assert.rejects(pending, /Connection closed/);
  await assert.rejects(rpc.request('after-close', {}), /Connection closed/);
});

test('App Server transport uses existing proxy, preserves config, sends tool output', async t => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proxy = path.join(dir, 'proxy'); const record = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(proxy, `#!/usr/bin/env node\nconst fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);fs.appendFileSync(${JSON.stringify(record)},l+'\\n');if(!m.id)return;let result={};if(m.method==='thread/read')result={thread:{id:'test',status:{type:'idle'}}};if(m.method==='turn/start')result={turn:{id:'turn-1'}};console.log(JSON.stringify({id:m.id,result}));});\n`, { mode: 0o700 });
  const { appServerConnect } = await import('../skills/background-shell/scripts/transport.mjs');
  const client = await appServerConnect(proxy, '/explicit.sock', 'test');
  try { assert.equal(await client.status(), 'idle'); await client.wake('completion'); } finally { client.close(); }
  const requests = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
  const turn = requests.find(r => r.method === 'turn/start');
  assert.deepEqual(turn.params, { threadId: 'test', input: [], toolOutput: { name: 'background_shell_completion', output: 'completion' } });
});

test('Desktop dispatch retains the worker connection and delivers to the original thread', async t => {
  const home = temp(); const pipe = path.join(home, 'host.sock');
  const sockets = new Set(); let connections = 0, deliveries = 0, destination;
  const server = net.createServer(socket => {
    sockets.add(socket); connections++;
    socket.on('close', () => sockets.delete(socket));
    const frames = new Frames();
    socket.on('data', chunk => {
      for (const m of frames.push(chunk)) {
        let result;
        if (m.method === 'tools/list') result = { tools: ['read_thread', 'send_message_to_thread'].map(name => ({ namespace: 'codex_app', name })) };
        else if (m.params.tool === 'read_thread') result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ thread: { id: 'original', kind: 'codex', status: { type: 'idle' } } }) }] };
        else { deliveries++; destination = m.params.arguments.threadId; result = { success: true, contentItems: [] }; }
        socket.write(encodeFrame({ id: m.id, result }));
      }
    });
  });
  await new Promise(r => server.listen(pipe, r));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const launched = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, 'dispatch', '--wake', '--notify', 'desktop', '--', process.execPath, '-e', 'setTimeout(()=>{},50)'], {
      env: { ...process.env, CODEX_THREAD_ID: 'original', CODEX_APP_TOOLS_PIPE_PATH: pipe, BACKGROUND_SHELL_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', c => { stdout += c; }); p.stderr.on('data', c => { stderr += c; });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const end = await terminal(home, launched.id);
  // terminal() can see the command result before wake status settles.
  for (let i = 0; i < 100 && read(launched.resultPath).wake !== 'accepted'; i++) await sleep(20);
  assert.equal(read(launched.resultPath).wake, 'accepted'); assert.equal(end.exitCode, 0);
  assert.equal(destination, 'original'); assert.equal(deliveries, 1); assert.equal(connections, 2);
});
