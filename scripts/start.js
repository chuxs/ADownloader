// Launch the app. Some environments (e.g. VS Code's integrated tools) set
// ELECTRON_RUN_AS_NODE, which makes Electron behave like plain Node, so clear it.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
