import type { Readable } from 'node:stream';
import type { Draft, OcflObject, StorageRoot, User, VersionDetails, WriteContent } from '../../src/index.ts';

declare const readable: Readable;
declare const strings: AsyncIterable<string>;
declare const bytes: AsyncIterable<Uint8Array>;
declare const buffers: AsyncIterable<ArrayBuffer>;

export function detailsNeedAMessageAndAUser(): VersionDetails[] {
  const user: User = { name: 'Alice' };
  const withAddress: User = { name: 'Alice', address: 'mailto:alice@example.org' };
  // @ts-expect-error a user needs a name
  const nameless: User = { address: 'mailto:alice@example.org' };
  // @ts-expect-error the user is required
  const noUser: VersionDetails = { message: 'Initial deposit' };
  // @ts-expect-error the message is required
  const noMessage: VersionDetails = { user };
  // @ts-expect-error the user is a name and an address, not a string
  const bareName: VersionDetails = { message: 'Initial deposit', user: 'Alice' };
  const details: VersionDetails = { message: 'Initial deposit', user: withAddress };
  // @ts-expect-error read-only
  details.message = 'another';
  // @ts-expect-error read-only
  details.user = user;
  return [details, noUser, noMessage, bareName, { message: 'Initial deposit', user: nameless }];
}

export async function createTakesTheDetailsFirstAndTheCallbackLast(root: StorageRoot, details: VersionDetails): Promise<OcflObject> {
  const build = async (draft: Draft) => draft.write('a.txt', 'a');
  // @ts-expect-error the details are required
  await root.create('an-id', build);
  // @ts-expect-error the details come before the callback
  await root.create('an-id', build, details);
  // @ts-expect-error the callback is required
  await root.create('an-id', details);
  // @ts-expect-error the id is required
  await root.create(details, build);
  // @ts-expect-error the message is required
  await root.create('an-id', { user: { name: 'Alice' } }, build);
  // @ts-expect-error the callback is async
  await root.create('an-id', details, () => {});
  return root.create('an-id', details, build);
}

export async function updateTakesTheDetailsFirstAndTheCallbackLast(object: OcflObject, details: VersionDetails): Promise<OcflObject> {
  const change = async (draft: Draft) => draft.write('a.txt', 'a');
  // @ts-expect-error the details are required
  await object.update(change);
  // @ts-expect-error the details come before the callback
  await object.update(change, details);
  // @ts-expect-error the callback is required
  await object.update(details);
  // @ts-expect-error the user is required
  await object.update({ message: 'A change' }, change);
  // @ts-expect-error there are no update modes
  await object.update(details, change, { mode: 'REPLACE' });
  return object.update(details, change);
}

export async function writeTakesTextBytesOrAStreamOfEither(draft: Draft): Promise<WriteContent[]> {
  await draft.write('a', 'text');
  await draft.write('a', new Uint8Array(1));
  await draft.write('a', Buffer.from('text'));
  await draft.write('a', new Uint8Array(new ArrayBuffer(8), 2, 4));
  await draft.write('a', readable);
  await draft.write('a', new ReadableStream<Uint8Array>());
  await draft.write('a', strings);
  await draft.write('a', bytes);

  // @ts-expect-error not bytes: wrap it in a Uint8Array
  await draft.write('a', new ArrayBuffer(1));
  // @ts-expect-error not bytes: wrap its buffer in a Uint8Array
  await draft.write('a', new DataView(new ArrayBuffer(1)));
  // @ts-expect-error not bytes: wrap its buffer in a Uint8Array
  await draft.write('a', new Uint16Array(1));
  // @ts-expect-error pass its stream()
  await draft.write('a', new Blob(['text']));
  // @ts-expect-error pass its stream()
  await draft.write('a', new File(['text'], 'a.txt'));
  // @ts-expect-error a stream yields strings or Uint8Arrays
  await draft.write('a', buffers);
  // @ts-expect-error not content
  await draft.write('a', 42);
  // @ts-expect-error decode first: write stores a string as UTF-8
  await draft.write('a', 'aGVsbG8=', 'base64');
  // @ts-expect-error the content is required
  await draft.write('a');

  const content: WriteContent[] = ['text', new Uint8Array(1), strings, bytes, readable];
  return content;
}

export function aDraftOnlyWrites(draft: Draft): void {
  // @ts-expect-error there is no stream to write to
  draft.createWritable('a');
  // @ts-expect-error a draft is committed by returning from the callback
  draft.commit();
  // @ts-expect-error a draft is discarded by throwing from the callback
  draft.rollback();
}
