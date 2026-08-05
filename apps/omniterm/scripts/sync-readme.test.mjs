import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { syncReadme } from './sync-readme.mjs';

test('syncReadme copies the source README exactly', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omniterm-readme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = path.join(dir, 'source.md');
  const target = path.join(dir, 'target.md');
  const contents = '# omniterm\n\nPlain-English documentation.\n';
  await writeFile(source, contents);

  await syncReadme(source, target);

  assert.equal(await readFile(target, 'utf8'), contents);
  await assert.doesNotReject(syncReadme(source, target, { check: true }));
});

test('syncReadme check rejects a stale package README', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omniterm-readme-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = path.join(dir, 'source.md');
  const target = path.join(dir, 'target.md');
  await writeFile(source, '# Current README\n');
  await writeFile(target, '# Old README\n');

  await assert.rejects(
    syncReadme(source, target, { check: true }),
    /package README is out of date/,
  );
});
