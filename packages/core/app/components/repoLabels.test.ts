import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoLabels } from './repoLabels.js';

const repo = (id: string, path: string) => ({ id, path, name: path.split('/').pop() as string });

test('a repo with a unique name is labelled with just that name', () => {
  const labels = buildRepoLabels([repo('a', '/Users/dev/Acme/monots')]);
  assert.deepEqual(labels, { a: 'monots' });
});

test('same-named repos are qualified by their parent directory', () => {
  const labels = buildRepoLabels([
    repo('work', '/Users/dev/Acme/omniterm'),
    repo('personal', '/Users/dev/Personal/omniterm'),
  ]);
  assert.deepEqual(labels, {
    work: 'omniterm (Acme)',
    personal: 'omniterm (Personal)',
  });
});

test('qualifiers widen until they actually distinguish the repos', () => {
  // One shared parent name isn't enough — both would read "omniterm (src)".
  const labels = buildRepoLabels([
    repo('a', '/home/dev/alpha/src/omniterm'),
    repo('b', '/home/dev/beta/src/omniterm'),
  ]);
  assert.deepEqual(labels, {
    a: 'omniterm (alpha/src)',
    b: 'omniterm (beta/src)',
  });
});

test('collisions are grouped per name, leaving unique repos unqualified', () => {
  const labels = buildRepoLabels([
    repo('work', '/Users/dev/Acme/omniterm'),
    repo('personal', '/Users/dev/Personal/omniterm'),
    repo('docs', '/Users/dev/Acme/docs'),
  ]);
  assert.equal(labels.docs, 'docs');
  assert.equal(labels.work, 'omniterm (Acme)');
  assert.equal(labels.personal, 'omniterm (Personal)');
});
