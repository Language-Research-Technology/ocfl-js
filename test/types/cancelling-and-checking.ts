import type { Draft, FixityOptions, FixityProblem, FixityProgress, OcflObject, StorageRoot, UpdateOptions, VersionDetails } from '../../src/index.ts';

declare const details: VersionDetails;
declare const build: (draft: Draft) => Promise<void>;

export async function fixityTakesASignalAndAProgressCallback(object: OcflObject): Promise<(readonly FixityProblem[])[]> {
  const onProgress = ({ checkedFiles, totalFiles }: FixityProgress): void => void (checkedFiles / totalFiles);
  const options: FixityOptions = { signal: AbortSignal.timeout(1000), onProgress };
  // @ts-expect-error read-only
  options.signal = undefined;
  // @ts-expect-error progress is reported, not returned
  await object.checkFixity({ onProgress: (progress: FixityProgress) => progress.totalFiles - progress.uncheckedFiles });
  // @ts-expect-error the signal is an AbortSignal, not its controller
  await object.checkFixity({ signal: new AbortController() });
  return [await object.checkFixity(), await object.checkFixity({}), await object.checkFixity(options)];
}

export function progressIsReadOnly(progress: FixityProgress): void {
  // @ts-expect-error read-only
  progress.checkedFiles = 1;
}

export async function createAndUpdateTakeASignal(root: StorageRoot, object: OcflObject, signal: AbortSignal): Promise<OcflObject[]> {
  const options: UpdateOptions = { signal };
  // @ts-expect-error a create or update reports no progress
  await object.update(details, build, { onProgress: () => {} });
  // @ts-expect-error the options come after the callback
  await root.create('an-id', details, { signal }, build);
  return [await root.create('an-id', details, build, options), await object.update(details, build, { signal }), await object.update(details, build)];
}

export async function hasResolvesToABoolean(root: StorageRoot): Promise<boolean> {
  // @ts-expect-error the id is required
  await root.has();
  // @ts-expect-error it resolves to a boolean, not the object
  const object: OcflObject = await root.has('an-id');
  void object;
  return root.has('an-id');
}

export async function draftFilesAreAReadOnlySnapshotOfDigests(draft: Draft): Promise<string | undefined> {
  const files: ReadonlyMap<string, string> = await draft.files();
  // @ts-expect-error read-only
  files.set('a.txt', 'abc');
  // @ts-expect-error resolve it first
  const unresolved: ReadonlyMap<string, string> = draft.files();
  void unresolved;
  return files.get('a.txt');
}

export function versionDetailsMayGiveADate(): VersionDetails[] {
  const dated: VersionDetails = { ...details, createdAt: new Date('2019-03-01T00:00:00Z') };
  // @ts-expect-error a Date, not a string
  const text: VersionDetails = { ...details, createdAt: '2019-03-01T00:00:00Z' };
  // @ts-expect-error read-only
  dated.createdAt = new Date();
  return [dated, text, details];
}

export async function isCurrentResolvesToABoolean(object: OcflObject): Promise<boolean> {
  // @ts-expect-error await it
  const current: boolean = object.isCurrent();
  void current;
  return object.isCurrent();
}
