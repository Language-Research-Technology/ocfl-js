import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const layout = root.layout;
if (layout.extensionName !== '0003-hash-and-id-n-tuple-storage-layout') {
  throw new Error('Not a 0003 storage root');
}
const { digestAlgorithm, tupleSize, numberOfTuples } = layout;

// Node's names for the OCFL algorithms it names differently
const nodeNames: Record<string, string> = { 'sha512/256': 'sha512-256', 'blake2b-512': 'blake2b512' };
const nodeAlgorithm = nodeNames[digestAlgorithm] ?? digestAlgorithm;
const digestOf = (id: string) => createHash(nodeAlgorithm).update(id).digest('hex');

const oldName = (id: string) => encodeURIComponent(id).toLowerCase().replace(/\./g, '%2e');

function newName(id: string) {
  const encoded = encodeURIComponent(id)
    .replace(/%[0-9A-F]{2}/g, (hexEscape) => hexEscape.toLowerCase())
    .replace(/[.!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return encoded.length > 100 ? `${encoded.slice(0, 100)}-${digestOf(id)}` : encoded;
}

function tuples(id: string) {
  const digest = digestOf(id);
  return Array.from({ length: numberOfTuples }, (_, i) => digest.slice(i * tupleSize, (i + 1) * tupleSize));
}

for await (const entry of root.objects()) {
  if ('error' in entry) {
    continue;
  }
  const { id } = entry.object;
  const parent = path.join(root.path, ...tuples(id));
  const from = path.join(parent, oldName(id));
  const to = path.join(parent, newName(id));
  if (from !== to && existsSync(from) && !existsSync(to)) {
    await rename(from, to);
  }
}
