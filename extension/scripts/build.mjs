import * as esbuild from 'esbuild';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
mkdirSync(path.join(root, 'dist'), { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'src/background.js')],
  bundle: true,
  outfile: path.join(root, 'dist/background.js'),
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  logLevel: 'info',
  // kiwi-schema / fzstd / jszip pulled from node_modules
});

console.log('built extension/dist/background.js');
