import type { ByteRange, OcflFile, OcflObject, StorageRoot, User, Version } from '../../src/index.ts';

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
  version.created = new Date();
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
  const { number, created, message, user } = object.head;
  return [number + ocflVersion.length + digestAlgorithm.length + (missing ? 1 : 0), created, message, user];
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

export async function fileContent(file: OcflFile, range: ByteRange): Promise<[number, string, Uint8Array]> {
  // A stream is returned straight away, so it can be handed on without awaiting
  const whole: ReadableStream<Uint8Array> = file.stream();
  const part: ReadableStream<Uint8Array> = file.stream(range);
  file.stream({ start: 0, end: 99 });
  file.stream({ start: 100 });
  // @ts-expect-error a range is byte offsets
  file.stream({ start: '0' });
  // @ts-expect-error text is always UTF-8
  await file.text('latin1');
  await Promise.all([whole.cancel(), part.cancel()]);
  return [await file.size(), await file.text(), await file.bytes()];
}
