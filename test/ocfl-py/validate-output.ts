/**
 * Writes storage roots through the public API and validates them with ocfl-py's `ocfl-validate`.
 * Run with `pnpm check:ocfl-py`; set `OCFL_VALIDATE` to the validator's path if `ocfl-validate.py` isn't on the PATH.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createStorageRoot, type LayoutConfig, openStorageRoot, type StorageRoot, type VersionDetails } from '../../src/index.ts';
import { FLAT, objectRootOf } from '../helpers/drafts.ts';
import { HASH_AND_ID, HASHED, PATH_DIRECT } from '../helpers/layouts.ts';
import { fixtureObjects, objectRootsIn, writeFixtureRoot, writeForeignObject } from '../helpers/storage-roots.ts';

const VALIDATOR = process.env.OCFL_VALIDATE ?? 'ocfl-validate.py';

/**
 * Each layout, and whether ocfl-py can check the storage root's structure as well as its objects. It refuses
 * layouts it doesn't implement (0004 and path-direct), and a 0003 config.json that leaves out parameters the
 * extension gives defaults for (https://github.com/zimeon/ocfl-py/issues/173).
 */
const LAYOUTS: { layout: LayoutConfig; rootStructure: boolean }[] = [
  { layout: FLAT, rootStructure: true },
  { layout: { extensionName: HASH_AND_ID }, rootStructure: false },
  { layout: { extensionName: HASH_AND_ID, digestAlgorithm: 'md5', tupleSize: 2, numberOfTuples: 4 }, rootStructure: true },
  { layout: { extensionName: HASHED }, rootStructure: false },
  { layout: { extensionName: HASHED, digestAlgorithm: 'blake2b-512', shortObjectRoot: true }, rootStructure: false },
  { layout: { extensionName: PATH_DIRECT }, rootStructure: false },
];

const DETAILS: VersionDetails = {
  message: 'Written for ocfl-py',
  user: { name: 'ocfl-js', address: 'https://github.com/Language-Research-Technology/ocfl-js' },
};

/** A warning a check expects, keyed by code, with why */
type Expected = Record<string, string>;

const run = promisify(execFile);
const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ocfl-py-'));
const failures: string[] = [];

async function* chunked(): AsyncIterable<string | Uint8Array> {
  yield 'streamed ';
  yield new TextEncoder().encode('in chunks');
}

/** Runs the validator on `paths`, and records a failure unless it passes them all with only `expected` warnings */
async function validate(label: string, paths: string[], expected: Expected): Promise<void> {
  if (paths.length === 0) {
    failures.push(`${label}: nothing to validate`);
    return;
  }
  const { code, output } = await run(VALIDATOR, paths).then(
    ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error: { code?: number | string; stdout?: string; stderr?: string }) => ({ code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  );
  console.log(`## ${label}\n${output.trim() || '(no output)'}\n`);
  if (code !== 0) {
    failures.push(`${label}: ocfl-validate exited ${code}`);
  }
  // ocfl-py prints `[W004] …`, or `Unknown warning: W0xx …` for a code it has no description of
  for (const warning of output.match(/(?<=^(?:\[|Unknown warning: ))W\d{3}/gm) ?? []) {
    if (!(warning in expected)) {
      failures.push(`${label}: unexpected warning ${warning}`);
    }
  }
}

/** Validates every object in `root`, and with `rootStructure` the storage root's structure */
async function validateRoot(label: string, root: StorageRoot, rootStructure: boolean, expected: Expected = {}): Promise<void> {
  await validate(`${label}: objects`, await objectRootsIn(root.path), expected);
  if (rootStructure) {
    await validate(`${label}: storage root structure`, [root.path], expected);
  }
}

/** Runs `check`, recording a failure if it throws, so one broken case doesn't hide the rest */
async function attempt(label: string, check: () => Promise<void>): Promise<void> {
  await check().catch((error: unknown) => {
    console.error(`## ${label}\n`, error);
    failures.push(`${label}: threw ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Uses every draft operation across four versions of a new object, then creates and purges another */
async function writeEveryOperation(root: StorageRoot, label: string, rootStructure: boolean): Promise<void> {
  const source = await fs.promises.mkdtemp(path.join(temp, 'import-'));
  await fs.promises.mkdir(path.join(source, 'nested'));
  await fs.promises.writeFile(path.join(source, 'nested', 'imported.txt'), 'imported\n');
  await fs.promises.writeFile(
    path.join(source, 'binary.bin'),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  );

  const id = 'urn:example:ocfl-js:every-operation';
  const object = await root.create(id, DETAILS, async (draft) => {
    await draft.write('text.txt', 'text\n');
    await draft.write('bytes.bin', new Uint8Array([0, 1, 2, 3]));
    await draft.write('dir/streamed.txt', chunked());
    await draft.write('name with spaces and ünïcödé.txt', 'unicode\n');
    await draft.import(source, { target: 'imported' });
  });
  const v2 = await object.update(DETAILS, async (draft) => {
    await draft.copy('text.txt', 'copies/text.txt');
    await draft.rename('dir', 'renamed-dir');
    await draft.remove('bytes.bin');
  });
  const v3 = await v2.update(DETAILS, (draft) => draft.reinstate('bytes.bin', 1));
  await v3.update(DETAILS, async (draft) => {
    await draft.clear();
    await draft.write('only.txt', 'only\n');
    // Until the callback returns, the lock is held and the object's directory in the workspace holds the new version
    await validateRoot(`${label}, with an unfinished write`, root, rootStructure);
  });

  const removed = 'urn:example:ocfl-js:removed';
  await root.create(removed, DETAILS, (draft) => draft.write('gone.txt', 'gone\n'));
  await root.purge(removed);
}

try {
  for (const [i, { layout, rootStructure }] of LAYOUTS.entries()) {
    const label = JSON.stringify(layout);
    await attempt(label, async () => {
      const root = await createStorageRoot(path.join(temp, `root-${i}`), { layout });
      await writeEveryOperation(root, label, rootStructure);
      await validateRoot(label, root, rootStructure);
    });
  }

  // Objects other tools wrote, updated by this library
  for (const {
    name,
    dir,
    inventory: { id = name },
  } of fixtureObjects('good-objects')) {
    const label = `fixture ${name}, updated`;
    await attempt(label, async () => {
      const rootPath = path.join(temp, `fixture-${name}`);
      await writeFixtureRoot(rootPath, dir, id);
      const root = await openStorageRoot(rootPath);
      const object = await root.open(id);
      await object.update(DETAILS, async (draft) => {
        const [first] = object.head.files.keys();
        if (first !== undefined) {
          await draft.rename(first, `renamed/${first}`);
        }
        await draft.write('added by ocfl-js.txt', 'added\n');
      });
      await validateRoot(label, root, false);
    });
  }

  const label = 'a sha256 object, updated';
  await attempt(label, async () => {
    const flat = await createStorageRoot(path.join(temp, 'sha256'), { layout: FLAT });
    const id = 'urn:example:sha256-object';
    await writeForeignObject(objectRootOf(flat, id), id, { 'a.txt': 'a\n' }, { digestAlgorithm: 'sha256' });
    await (await flat.open(id)).update(DETAILS, (draft) => draft.write('b.txt', 'b\n'));
    await validateRoot(label, flat, true, { W004: 'the object, written as another tool might, uses sha256' });
  });
} finally {
  if (failures.length === 0) {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`ocfl-py found problems, in storage roots kept at ${temp}:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('ocfl-py found every object valid, with only the expected warnings');
