// Runs make-icon.cjs inside Electron (clearing ELECTRON_RUN_AS_NODE, see start.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'make-icon.cjs');
const child = spawn(electron, [script], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
