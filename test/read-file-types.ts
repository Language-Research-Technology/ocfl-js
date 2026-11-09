import type { BinaryOptions, EncodingOptions, OcflObject, OcflObjectFile } from '../src/index.ts';

declare function expectText(result: Promise<string>): void;
declare function expectBytes(result: Promise<Uint8Array>): void;

declare const someString: string;
declare const encodingOptions: EncodingOptions;
declare const binaryOptions: BinaryOptions;

export function pinObject(object: OcflObject) {
  expectText(object.readFile('a', 'utf8'));
  expectText(object.readFile('a', { encoding: 'utf8' }));
  expectText(object.readFile('a', { encoding: 'utf8', flag: 'r' }));
  expectText(object.readFile('a', encodingOptions));

  expectBytes(object.readFile('a'));
  expectBytes(object.readFile('a', { flag: 'r' }));
  expectBytes(object.readFile('a', { encoding: null }));
  expectBytes(object.readFile('a', { encoding: undefined }));
  expectBytes(object.readFile('a', binaryOptions));

  // @ts-expect-error a plain string might not be an encoding
  object.readFile('a', someString);
  // @ts-expect-error a plain string might not be an encoding
  object.readFile('a', { encoding: someString });
}

export function pinForwarding(object: OcflObject, options: EncodingOptions | BinaryOptions, encoding?: BufferEncoding) {
  object.readFile('a', encoding);
  object.readFile('a', { encoding });

  // @ts-expect-error may resolve to bytes
  expectText(object.readFile('a', options));
  // @ts-expect-error may resolve to a string
  expectBytes(object.readFile('a', options));
  // @ts-expect-error may resolve to bytes
  expectText(object.readFile('a', encoding));
  // @ts-expect-error may resolve to a string
  expectBytes(object.readFile('a', encoding));
}

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
