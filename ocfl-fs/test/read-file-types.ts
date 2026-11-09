import type { BinaryOptions, EncodingOptions, OcflObject, OcflObjectFile, OcflStore } from '@ocfl/ocfl';
import type { OcflFsStore } from '../src/store.ts';

declare function expectText(result: Promise<string>): void;
declare function expectBytes(result: Promise<Uint8Array>): void;

declare const someString: string;
declare const encodingOptions: EncodingOptions;
declare const binaryOptions: BinaryOptions;

export function pinStore(store: OcflStore) {
  expectText(store.readFile('a', 'utf8'));
  expectText(store.readFile('a', { encoding: 'utf8' }));
  expectText(store.readFile('a', { encoding: 'utf8', flag: 'r' }));
  expectText(store.readFile('a', encodingOptions));

  expectBytes(store.readFile('a'));
  expectBytes(store.readFile('a', { flag: 'r' }));
  expectBytes(store.readFile('a', { encoding: null }));
  expectBytes(store.readFile('a', { encoding: undefined }));
  expectBytes(store.readFile('a', binaryOptions));

  // @ts-expect-error a plain string might not be an encoding
  store.readFile('a', someString);
  // @ts-expect-error a plain string might not be an encoding
  store.readFile('a', { encoding: someString });
}

export function pinForwarding(store: OcflStore, options: EncodingOptions | BinaryOptions, encoding?: BufferEncoding) {
  store.readFile('a', encoding);
  store.readFile('a', { encoding });

  // @ts-expect-error may resolve to bytes
  expectText(store.readFile('a', options));
  // @ts-expect-error may resolve to a string
  expectBytes(store.readFile('a', options));
  // @ts-expect-error may resolve to bytes
  expectText(store.readFile('a', encoding));
  // @ts-expect-error may resolve to a string
  expectBytes(store.readFile('a', encoding));
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type FsStoreMatchesStore = Expect<Equal<OcflFsStore['readFile'], OcflStore['readFile']>>;
export type ObjectMatchesStore = Expect<Equal<OcflObject['readFile'], OcflStore['readFile']>>;

export function pinFileBuffer(file: OcflObjectFile) {
  expectBytes(file.buffer());
  expectBytes(file.buffer({ flag: 'r' }));
  expectBytes(file.buffer({ encoding: null }));
  expectBytes(file.buffer(binaryOptions));

  // @ts-expect-error buffer() always resolves to bytes
  file.buffer({ encoding: 'utf8' });
  // @ts-expect-error buffer() always resolves to bytes
  file.buffer('utf8');
}
