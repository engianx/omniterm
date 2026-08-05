import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keep the npm package README identical to the repository README.
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{ check?: boolean }} options
 */
export async function syncReadme(sourcePath, targetPath, { check = false } = {}) {
  const source = await readFile(sourcePath, 'utf8');

  if (check) {
    let target = '';
    try {
      target = await readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (target !== source) {
      throw new Error(
        'The package README is out of date. Run `pnpm readme:sync` from the repository root.',
      );
    }
    return;
  }

  await writeFile(targetPath, source);
}

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) {
    console.error('Usage: node sync-readme.mjs [--check]');
    process.exitCode = 1;
  } else {
    const appDir = path.resolve(path.dirname(scriptPath), '..');
    const repoRoot = path.resolve(appDir, '../..');

    try {
      await syncReadme(path.join(repoRoot, 'README.md'), path.join(appDir, 'README.md'), {
        check: args.includes('--check'),
      });
      if (!args.includes('--check')) {
        console.log('[omniterm] Synced apps/omniterm/README.md from README.md.');
      }
    } catch (error) {
      console.error(`[omniterm] ${error.message}`);
      process.exitCode = 1;
    }
  }
}
