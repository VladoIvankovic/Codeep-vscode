import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(projectRoot, 'node_modules', '@vscode', 'codicons', 'dist');
const targetDir = join(projectRoot, 'media');

await mkdir(targetDir, { recursive: true });
await Promise.all([
  copyFile(join(sourceDir, 'codicon.css'), join(targetDir, 'codicon.css')),
  copyFile(join(sourceDir, 'codicon.ttf'), join(targetDir, 'codicon.ttf')),
]);
