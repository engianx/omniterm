export interface LabelableRepo {
  id: string;
  name: string;
  path: string;
}

/**
 * Display labels for the workspaces panel, keyed by repo id.
 *
 * Repo ids are path-derived and unique (see lib/ids.ts), but the readable part
 * is still just the directory name — two tracked checkouts both called
 * `omniterm` would render as two identical rows with no way to tell which is
 * which. When names collide, each row is qualified with the shortest trailing
 * slice of its parent path that separates it from the others in the group:
 * `omniterm (Acme)` and `omniterm (Personal)`. Nested layouts that share a
 * parent name (a/src/omniterm vs b/src/omniterm) widen to `a/src` and `b/src`.
 */
export function buildRepoLabels<T extends LabelableRepo>(repos: T[]): Record<string, string> {
  const byName = new Map<string, T[]>();
  for (const repo of repos) {
    const group = byName.get(repo.name);
    if (group) group.push(repo);
    else byName.set(repo.name, [repo]);
  }

  const labels: Record<string, string> = {};
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels[group[0].id] = name;
      continue;
    }

    // Parent directory segments for each repo in the collision group, e.g.
    // /Users/dev/Acme/omniterm → ['Users', 'dev', 'Acme'].
    const parents = group.map((repo) => repo.path.split('/').filter(Boolean).slice(0, -1));
    const maxDepth = Math.max(...parents.map((segments) => segments.length));

    let depth = 1;
    while (depth < maxDepth) {
      const qualifiers = new Set(parents.map((segments) => segments.slice(-depth).join('/')));
      if (qualifiers.size === group.length) break;
      depth++;
    }

    group.forEach((repo, i) => {
      const qualifier = parents[i].slice(-depth).join('/');
      // A repo at the filesystem root has no parent segments to qualify with.
      labels[repo.id] = qualifier ? `${name} (${qualifier})` : name;
    });
  }
  return labels;
}
