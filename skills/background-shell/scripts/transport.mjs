import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';

const MAX_FRAME = 8 * 1024 * 1024;

export class Rpc {
  constructor(send, dispose, timeoutMs = 15000) {
    this.send = send;
    this.dispose = dispose;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closedError = null;
  }
  request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Response timeout: ${method}; outcome may be unknown`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    const p = this.pending.get(message.id);
    if (!p) return; // Notifications and other clients' traffic are not responses.
    this.pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(message.error.message ?? 'RPC error'));
    else p.resolve(message.result);
  }
  close(error = new Error('Connection closed; outcome may be unknown')) {
    if (this.closedError) return;
    this.closedError = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.dispose();
  }
}

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME) throw new Error('Frame too large');
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class Frames {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const size = os.endianness() === 'LE' ? this.buffer.readUInt32LE() : this.buffer.readUInt32BE();
      if (size > MAX_FRAME) throw new Error('Frame too large');
      if (this.buffer.length < size + 4) break;
      messages.push(JSON.parse(this.buffer.subarray(4, size + 4).toString()));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return messages;
  }
}

export async function desktopConnect(pipePath, threadId, timeoutMs = 15000, wakeTimeoutMs = 60000) {
  const socket = net.createConnection(pipePath);
  const frames = new Frames();
  const rpc = new Rpc(m => socket.write(encodeFrame(m)), () => socket.destroy(), timeoutMs);
  socket.on('error', e => rpc.close(e));
  socket.on('close', () => rpc.close());
  socket.on('data', chunk => {
    try { for (const m of frames.push(chunk)) rpc.receive(m); }
    catch (error) { rpc.close(error); }
  });
  const call = async (tool, args, requestTimeoutMs = timeoutMs) => {
    // Same fallback context ID used by the bundled app-tools MCP server.
    const result = await rpc.request('tools/call', {
      callerSource: 'codex', namespace: 'codex_app', tool,
      threadId, turnId: `background-shell-${process.pid}`,
      callId: `background-shell-${process.pid}-${rpc.sequence + 1}`,
      arguments: args,
    }, requestTimeoutMs);
    if (!result?.success) throw new Error('Desktop tool rejected the request');
    return result.contentItems;
  };
  try {
    const result = await rpc.request('tools/list', { threadStartKind: 'all' });
    for (const name of ['read_thread', 'send_message_to_thread']) {
      if (!result?.tools?.some(t => t.namespace === 'codex_app' && t.name === name)) {
        throw new Error(`Desktop tool unavailable: ${name}`);
      }
    }
    const snapshot = async () => {
        const content = await call('read_thread', {
          threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0,
        });
        const text = content?.find(c => c.type === 'inputText')?.text;
        const data = JSON.parse(text);
        if (data.thread?.id !== threadId || data.thread?.kind !== 'codex') throw new Error('Thread identity mismatch');
        return { status: data.thread.status?.type, latestTurnId: data.turns?.[0]?.id ?? null };
    };
    return {
      close: () => rpc.close(), snapshot,
      status: async () => (await snapshot()).status,
      wake: async prompt => call('send_message_to_thread', { threadId, prompt }, wakeTimeoutMs),
    };
  } catch (error) { rpc.close(); throw error; }
}

export async function appServerConnect(codex, socketPath, threadId, timeoutMs = 15000, wakeTimeoutMs = 60000) {
  const child = spawn(codex, ['app-server', 'proxy', '--sock', socketPath], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rpc = new Rpc(m => child.stdin.write(`${JSON.stringify(m)}\n`), () => child.kill(), timeoutMs);
  child.on('error', e => rpc.close(e));
  child.on('exit', () => rpc.close());
  child.stdin.on('error', e => rpc.close(e));
  let buffer = '';
  child.stdout.setEncoding('utf8'); // Preserve Unicode characters split across chunks.
  child.stdout.on('data', chunk => {
    try {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_FRAME) throw new Error('RPC output too large');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line) rpc.receive(JSON.parse(line));
      }
    } catch (error) { rpc.close(error); }
  });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'background_shell', version: '0.2.0' }, capabilities: {} });
    rpc.send({ jsonrpc: '2.0', method: 'initialized' });
    let loaded = false;
    return {
      close: () => rpc.close(),
      status: async () => {
        const data = await rpc.request('thread/read', { threadId, includeTurns: false });
        if (data.thread?.id !== threadId) throw new Error('Thread identity mismatch');
        let status = data.thread.status?.type;
        if (status === 'notLoaded' && !loaded) {
          const resumed = await rpc.request('thread/resume', { threadId });
          loaded = true; status = resumed.thread?.status?.type;
        }
        return status;
      },
      wake: async output => rpc.request('turn/start', {
        threadId, input: [], toolOutput: { name: 'background_shell_completion', output },
      }, wakeTimeoutMs),
    };
  } catch (error) { rpc.close(); throw error; }
}
