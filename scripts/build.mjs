import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');

const sharedConfig = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: false,
  minify: false,
  external: ['vscode'],
  logLevel: 'info',
};

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await Promise.all([
  esbuild.build({
    ...sharedConfig,
    entryPoints: [path.join(projectRoot, 'src', 'extension.cjs')],
    outfile: path.join(distDir, 'extension.cjs'),
  }),
  esbuild.build({
    ...sharedConfig,
    entryPoints: [path.join(projectRoot, 'src', 'mcp', 'qqbot-mcp-server.cjs')],
    outfile: path.join(distDir, 'mcp', 'qqbot-mcp-server.cjs'),
  }),
]);