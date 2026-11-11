export const HASHED = '0004-hashed-n-tuple-storage-layout';
export const PATH_DIRECT = '000N-path-direct-storage-layout';

/** The 0004 layout as a storage root reports it when no parameter is set */
export const HASHED_DEFAULTS: { extensionName: typeof HASHED; digestAlgorithm: string; tupleSize: number; numberOfTuples: number; shortObjectRoot: boolean } = {
  extensionName: HASHED,
  digestAlgorithm: 'sha256',
  tupleSize: 3,
  numberOfTuples: 3,
  shortObjectRoot: false,
};

/** Names that are not a layout this library implements, including registered extensions and inherited property names */
export const UNSUPPORTED_LAYOUT_NAMES: string[] = [
  'no-such-layout',
  '0006-flat-omit-prefix-storage-layout',
  '0007-n-tuple-omit-prefix-storage-layout',
  '0009-digest-algorithms',
  'FlatDirectStorageLayout',
  'constructor',
  '__proto__',
  'toString',
];

type InvalidLayout = [problem: string, layout: Record<string, unknown>];

const rowsFor = (extensionName: string, rows: InvalidLayout[]): InvalidLayout[] =>
  rows.map(([problem, params]) => [`${problem} for ${extensionName.slice(0, 4)}`, { extensionName, ...params }]);

/** Layout configs that name a layout this library implements, with parameters it must reject */
export const INVALID_LAYOUT_PARAMETERS: InvalidLayout[] = [
  ['an unknown digestAlgorithm for 0003', { extensionName: '0003-hash-and-id-n-tuple-storage-layout', digestAlgorithm: 'nope' }],
  ['an unknown digestAlgorithm for 0004', { extensionName: HASHED, digestAlgorithm: 'nope' }],
  ['tuples longer than the digest for 0003', { extensionName: '0003-hash-and-id-n-tuple-storage-layout', tupleSize: 33, numberOfTuples: 2 }],
  ['tuples longer than the digest for 0004', { extensionName: HASHED, tupleSize: 33, numberOfTuples: 2 }],
  ['shortObjectRoot with tuples using the whole digest for 0004', { extensionName: HASHED, tupleSize: 32, numberOfTuples: 2, shortObjectRoot: true }],
  ...['0003-hash-and-id-n-tuple-storage-layout', HASHED].flatMap((extensionName) =>
    rowsFor(extensionName, [
      ['a string tupleSize', { tupleSize: '3' }],
      ['a string numberOfTuples', { numberOfTuples: 'x' }],
      ['a numeric digestAlgorithm', { digestAlgorithm: 5 }],
      ['an empty digestAlgorithm', { digestAlgorithm: '' }],
      ['a negative tupleSize', { tupleSize: -1 }],
      ['a fractional tupleSize', { tupleSize: 2.5 }],
      ['a NaN numberOfTuples', { numberOfTuples: Number.NaN }],
      ['numberOfTuples over 32', { tupleSize: 1, numberOfTuples: 33 }],
      ['tupleSize over 32', { tupleSize: 33, numberOfTuples: 1 }],
      ['a zero tupleSize with tuples', { tupleSize: 0, numberOfTuples: 3 }],
      ['tuples with a zero numberOfTuples', { tupleSize: 3, numberOfTuples: 0 }],
    ]),
  ),
  ...rowsFor(HASHED, [['a string shortObjectRoot', { shortObjectRoot: 'yes' }]]),
  ...rowsFor('000N-path-direct-storage-layout', [
    ['a string omitScheme', { omitScheme: 'yes' }],
    ['a numeric suffix', { suffix: 5 }],
    ['a string replace', { replace: 'abc' }],
    ['a replace pair without a replacement', { replace: [['a']] }],
    ['a replace pair with a numeric pattern', { replace: [[1, 'b']] }],
    ['a replace pair with a RegExp pattern', { replace: [[/a/g, 'b']] }],
    ['a replace pair with a numeric replacement', { replace: [['a', 2]] }],
    ['a replace pair with three elements', { replace: [['a', 'b', 'c']] }],
    ['a replace entry that is not a pair', { replace: ['ab'] }],
    ['a replace entry that is undefined', { replace: [undefined, ['a', 'b']] }],
  ]),
];
