import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./skills/background-shell', import.meta.url));
const target = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'background-shell');
if (fs.existsSync(target)) {
  console.error(`Already exists; no changes made: ${target}`);
  process.exitCode = 1;
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  console.log(`Installed ${target}. Available on the next Codex turn.`);
}
