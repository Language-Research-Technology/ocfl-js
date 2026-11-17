import type {
  CreateOptions,
  Draft,
  DraftFile,
  FixityOptions,
  FixityProblem,
  FixityProgress,
  OcflObject,
  StorageRoot,
  UpdateOptions,
  VersionDetails,
} from '../../src/index.ts';

declare const details: VersionDetails;
declare const build: (draft: Draft) => Promise<void>;
declare const draftFile: DraftFile;

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
  const updateOptions: UpdateOptions = { ...details, signal };
  const createOptions: CreateOptions = { ...details, signal };
  // @ts-expect-error read-only
  updateOptions.signal = undefined;
  // @ts-expect-error read-only
  createOptions.message = 'changed';
  // @ts-expect-error read-only
  createOptions.signal = undefined;
  // @ts-expect-error a create or update reports no progress
  await object.update({ ...details, onProgress: () => {} }, build);
  // @ts-expect-error the callback comes last
  await object.update(details, build, { signal });
  // @ts-expect-error the callback comes last
  await root.create('an-id', details, build, { signal });
  // @ts-expect-error the options hold the version details
  await object.update({ signal }, build);
  return [await root.create('an-id', createOptions, build), await object.update(updateOptions, build), await object.update(details, build)];
}

export async function hasResolvesToABoolean(root: StorageRoot): Promise<boolean> {
  // @ts-expect-error the id is required
  await root.has();
  // @ts-expect-error it resolves to a boolean, not the object
  const object: OcflObject = await root.has('an-id');
  void object;
  return root.has('an-id');
}

export async function draftFilesAreAReadOnlySnapshot(draft: Draft): Promise<string | undefined> {
  const files: ReadonlyMap<string, DraftFile> = await draft.files();
  // @ts-expect-error read-only
  files.set('a.txt', { path: 'a.txt', digest: 'abc' });
  // @ts-expect-error read-only
  draftFile.digest = 'abc';
  // @ts-expect-error resolve it first
  const unresolved: ReadonlyMap<string, DraftFile> = draft.files();
  void unresolved;
  return files.get('a.txt')?.digest;
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
