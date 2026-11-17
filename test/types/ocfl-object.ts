import type { Readable } from 'node:stream';
import type { Draft, FixityProblem, OcflFile, OcflObject, StorageRoot, StreamOptions, User, Version } from '../../src/index.ts';

export async function openTakesOnlyAnId(root: StorageRoot): Promise<OcflObject> {
  // @ts-expect-error an object is opened by its id, not its path
  await root.open({ root: 'object_1' });
  // @ts-expect-error the id is required
  await root.open();
  return root.open('an-id');
}

export function objectIsReadOnly(object: OcflObject, version: Version, file: OcflFile): void {
  // @ts-expect-error read-only
  object.id = 'another';
  // @ts-expect-error read-only
  object.head = version;
  // @ts-expect-error read-only
  object.versions.set(2, version);
  // @ts-expect-error read-only
  version.createdAt = new Date();
  // @ts-expect-error read-only
  version.files.delete('a.txt');
  // @ts-expect-error read-only
  file.digest = 'abc';
}

export function objectPropertiesAreNarrow(object: OcflObject): [number, Date, string | undefined, User | undefined] {
  const ocflVersion: '1.0' | '1.1' = object.ocflVersion;
  const digestAlgorithm: 'sha256' | 'sha512' = object.digestAlgorithm;
  // @ts-expect-error a version that doesn't exist is undefined
  const missing: Version = object.versions.get(9);
  const { number, createdAt, message, user } = object.head;
  // @ts-expect-error renamed createdAt
  object.head.created;
  return [number + ocflVersion.length + digestAlgorithm.length + (missing ? 1 : 0), createdAt, message, user];
}

export function fileDatesComeFromVersions(file: OcflFile): [Date, Date, Version, Version] {
  // @ts-expect-error read-only
  file.createdAt = new Date();
  // @ts-expect-error read-only
  file.modifiedAt = new Date();
  // @ts-expect-error read-only
  file.createdIn = file.modifiedIn;
  // @ts-expect-error read-only
  file.modifiedIn = file.createdIn;
  const { createdAt, modifiedAt, createdIn, modifiedIn } = file;
  return [createdAt, modifiedAt, createdIn, modifiedIn];
}

export function nothingOfTheOldObjectIsLeft(object: OcflObject, file: OcflFile): void {
  // @ts-expect-error an opened object doesn't change, so there is nothing to load
  object.load();
  // @ts-expect-error files are found through a version
  object.getFile('a.txt');
  // @ts-expect-error no disk path
  object.root;
  // @ts-expect-error no content path
  file.contentPath;
  // @ts-expect-error the size is read from disk
  const size: number = file.size;
  void size;
}

export function fixityProblemNamesItsKind(problem: FixityProblem): 'changed' | 'missing' {
  // @ts-expect-error the kind is `kind`, not `problem`
  problem.problem;
  return problem.kind;
}

export function fixityProblemNamesTheStoredFileFromTheStorageRoot(problem: FixityProblem): [string, string[], string | undefined] {
  // @ts-expect-error a stored file is named from the storage root, not the object
  problem.contentPath;
  // @ts-expect-error read-only
  problem.affects.push({ version: 1, path: 'a.txt' });
  const files: string[] = problem.affects.map(({ version, path }) => `v${version}:${path}`);
  return [problem.storedFile, files, problem.actual];
}

export async function fileContent(file: OcflFile, options: StreamOptions, draft: Draft): Promise<[number, string, Uint8Array]> {
  // A stream resolves once the content is open, so a server can still answer with an error status
  const whole: Readable = await file.stream();
  const part: Readable = await file.stream(options);
  // @ts-expect-error await it
  const unopened: Readable = file.stream();
  void unopened;
  await file.stream({ start: 0, end: 99 });
  await file.stream({ start: 100 });
  await file.stream({ end: 99 });
  // @ts-expect-error a range is byte offsets
  await file.stream({ start: '0' });
  // @ts-expect-error text is always UTF-8
  await file.text('latin1');
  await draft.write('copy', whole);
  part.destroy();
  return [await file.size(), await file.text(), await file.bytes()];
}
