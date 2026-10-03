import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function readOptional(file) {
  try { return read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function notificationPaths(job, dir) {
  // Desktop executors have different pipes but share the same thread identity.
  const scope = job.notify === 'app-server' ? job.socketPath : 'desktop';
  const key = createHash('sha256').update(JSON.stringify([scope, job.threadId])).digest('hex');
  const root = path.join(path.dirname(dir), '.wake-threads');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('Notification store must be a private, owned directory (0700)');
  }
  return { lock: path.join(root, `${key}.lock`), barrier: path.join(root, `${key}.json`) };
}

export function tryNotificationLock(file) {
  const token = randomBytes(16).toString('hex');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = read(file); } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Invalid notification lock: ${file}`);
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') throw new Error(`Stale notification lock; inspect before removing: ${file}`);
      if (error.code !== 'EPERM') throw error;
    }
    return null;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  fs.closeSync(fd);
  return () => {
    const owner = readOptional(file);
    if (owner?.token === token) fs.unlinkSync(file);
  };
}

export function acknowledged(dir) { return readOptional(path.join(dir, 'ack.json')); }

export async function acknowledge(dir, atomicJson) {
  const job = read(path.join(dir, 'job.json'));
  const paths = notificationPaths(job, dir);
  const deadline = Date.now() + (job.notifyTimeoutMs ?? 60000) + 5000;
  let release;
  while (!(release = tryNotificationLock(paths.lock))) {
    if (Date.now() >= deadline) throw new Error('Notification is still in flight; acknowledgement not recorded');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  try {
    const state = read(path.join(dir, 'state.json'));
    if (!['succeeded', 'failed', 'timed-out', 'cancelled'].includes(state.status)) {
      throw new Error('Only a completed command can be acknowledged; inspect its results first');
    }
    let ack = acknowledged(dir);
    if (!ack) {
      ack = { id: job.id, acknowledgedAt: new Date().toISOString(), status: state.status,
        exitCode: state.exitCode, signal: state.signal, endedAt: state.endedAt };
      // Separate marker: never overwrite a live supervisor's state snapshot.
      atomicJson(path.join(dir, 'ack.json'), ack);
    }
    return { ...ack, wake: state.wake, notificationAlreadyAttempted: fs.existsSync(path.join(dir, 'wake.lock')) };
  } finally { release(); }
}
