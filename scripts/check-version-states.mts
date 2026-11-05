#!/usr/bin/env node
/**
 * Scan OCFL objects for invalid version states.
 *
 * Usage: node scripts/check-version-states.mts <storage-root-or-object-root>... [--json]
 *
 * Reads each object's root inventory.json and checks every version state for:
 * - duplicate:  a logical path under more than one digest, or twice under one (E095)
 * - conflict:   a logical path that is also a directory of another path (E095)
 * - empty:      a digest with no logical paths
 * - manifest:   a state digest that isn't in the manifest (E050)
 *
 * Exits 1 if any object has a problem, 2 if an inventory can't be read.
 */
import type { Dir } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import path from 'node:path';

type Inventory = {
  id: string;
  head: string;
  manifest: Record<string, string[]>;
  versions: Record<string, { state: Record<string, string[]> }>;
};

type Problem = { kind: 'duplicate' | 'conflict' | 'empty' | 'manifest'; detail: string; versions: string[] };

const skipped: { dir: string; error: string }[] = [];

async function* findObjectRoots(dir: string): AsyncGenerator<string> {
  const subdirs: string[] = [];
  let isObject = false;
  let handle: Dir;
  try {
    handle = await opendir(dir);
  } catch (e) {
    const error = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    skipped.push({ dir, error });
    console.warn(`WARN skipping ${dir}: ${error}`);
    return;
  }
  for await (const entry of handle) {
    if (entry.isFile() && entry.name.startsWith('0=ocfl_object_')) {
      isObject = true;
    } else if (entry.isDirectory()) {
      subdirs.push(entry.name);
    }
  }
  if (isObject) {
    yield dir;
    return;
  }
  for (const name of subdirs.sort()) {
    yield* findObjectRoots(path.join(dir, name));
  }
}

const short = (digest: string) => (digest.length > 16 ? `${digest.slice(0, 12)}…` : digest);

function checkState(state: Record<string, string[]>, manifest: Record<string, string[]>): Omit<Problem, 'versions'>[] {
  const problems: Omit<Problem, 'versions'>[] = [];
  const digestsByPath = new Map<string, string[]>();
  for (const [digest, paths] of Object.entries(state)) {
    if (paths.length === 0) {
      problems.push({ kind: 'empty', detail: `digest ${short(digest)} has no logical paths` });
    }
    if (!manifest[digest]) {
      problems.push({ kind: 'manifest', detail: `digest ${short(digest)} is not in the manifest` });
    }
    for (const p of paths) {
      digestsByPath.set(p, [...(digestsByPath.get(p) ?? []), digest]);
    }
  }
  for (const [p, digests] of digestsByPath) {
    const unique = [...new Set(digests)];
    if (unique.length > 1) {
      problems.push({ kind: 'duplicate', detail: `"${p}" is under ${unique.length} digests: ${unique.map(short).join(', ')}` });
    } else if (digests.length > 1) {
      problems.push({ kind: 'duplicate', detail: `"${p}" is listed twice under ${short(unique[0] ?? '')}` });
    }
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) {
      const dir = p.slice(0, i);
      if (digestsByPath.has(dir)) {
        problems.push({ kind: 'conflict', detail: `"${dir}" is a file and also a directory of "${p}"` });
      }
    }
  }
  return problems;
}

function checkInventory(inv: Inventory): Problem[] {
  const byDetail = new Map<string, Problem>();
  const versionNames = Object.keys(inv.versions).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of versionNames) {
    for (const problem of checkState(inv.versions[v]?.state ?? {}, inv.manifest ?? {})) {
      const key = `${problem.kind}|${problem.detail}`;
      const existing = byDetail.get(key);
      if (existing) {
        existing.versions.push(v);
      } else {
        byDetail.set(key, { ...problem, versions: [v] });
      }
    }
  }
  return [...byDetail.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const roots = args.filter((a) => a !== '--json');
  if (roots.length === 0) {
    console.error('Usage: node scripts/check-version-states.mts <storage-root-or-object-root>... [--json]');
    process.exit(64);
  }

  let objects = 0;
  let bad = 0;
  let unreadable = 0;
  const results: { root: string; id?: string; head?: string; problems?: Problem[]; error?: string }[] = [];

  for (const root of roots) {
    for await (const objectRoot of findObjectRoots(path.resolve(root))) {
      objects++;
      if (objects % 1000 === 0) {
        console.warn(`... ${objects} objects scanned (${bad} with problems)`);
      }
      let inv: Inventory;
      try {
        inv = JSON.parse(await readFile(path.join(objectRoot, 'inventory.json'), 'utf8'));
      } catch (e) {
        unreadable++;
        results.push({ root: objectRoot, error: (e as Error).message });
        if (!json) {
          console.log(`ERROR ${objectRoot}: ${(e as Error).message}`);
        }
        continue;
      }
      const problems = checkInventory(inv);
      if (problems.length === 0) {
        continue;
      }
      bad++;
      results.push({ root: objectRoot, id: inv.id, head: inv.head, problems });
      if (!json) {
        console.log(`\n${inv.id}  (head ${inv.head})\n  ${objectRoot}`);
        for (const p of problems) {
          const first = p.versions[0];
          const span = p.versions.length > 1 ? `${first}..${p.versions.at(-1)} (${p.versions.length} versions)` : first;
          console.log(`  ${p.kind.padEnd(9)} ${span}: ${p.detail}`);
        }
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ objects, bad, unreadable, skipped, results }, null, 2));
  } else {
    console.log(`\nScanned ${objects} object(s): ${bad} with problems, ${unreadable} unreadable, ${skipped.length} director(ies) skipped.`);
  }
  process.exit(unreadable > 0 ? 2 : bad > 0 ? 1 : 0);
}

await main();
