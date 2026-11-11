import type { Readable } from 'node:stream';
import type { OcflObjectTransaction } from '../src/index.ts';

declare const readable: Readable;
declare const strings: AsyncIterable<string>;
declare const buffers: AsyncIterable<ArrayBuffer>;

export function pinWrite(t: OcflObjectTransaction) {
  t.write('a', 'text');
  t.write('a', new Uint8Array(1));
  t.write('a', new Uint16Array(1));
  t.write('a', new DataView(new ArrayBuffer(1)));
  t.write('a', new ArrayBuffer(1));
  t.write('a', new Blob(['text']));
  t.write('a', new File(['text'], 'a.txt'));
  t.write('a', new ReadableStream<Uint8Array>());
  t.write('a', readable);
  t.write('a', strings);
  t.write('a', buffers);

  // @ts-expect-error decode first: write stores a string as UTF-8
  t.write('a', 'aGVsbG8=', 'base64');
  // @ts-expect-error write takes no options
  t.write('a', 'text', { mode: 0o600 });
  // @ts-expect-error not data
  t.write('a', 42);
}
