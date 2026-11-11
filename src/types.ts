import type { PathDirectStorageLayoutConfig } from './extensions/000N-path-direct-storage-layout.ts';
import type { HashAndIdNTupleStorageLayoutConfig } from './extensions/0003-hash-and-id-n-tuple-storage-layout.ts';
import type { HashedNTupleStorageLayoutConfig } from './extensions/0004-hashed-n-tuple-storage-layout.ts';

/** A digest algorithm OCFL allows for content addressing */
export type ContentAlgorithm = 'sha256' | 'sha512';

/** Digest values keyed by algorithm name */
export type Digests = { [algorithm: string]: string };

/** `T` and everything nested in it, read-only at compile time. The data isn't frozen. */
export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

export interface InventoryDigests {
  [key: string]: string[];
}

export interface InventoryVersion {
  created: string;
  message?: string;
  state: InventoryDigests;
  user?: {
    name: string;
    address?: string;
  };
}

export interface Inventory {
  /** A unique identifier for the OCFL Object. */
  id: string;
  /** The URI of the inventory section of the specification version matching the object conformance declaration. */
  type: 'https://ocfl.io/1.0/spec/#inventory' | 'https://ocfl.io/1.1/spec/#inventory';
  /**
   * The algorithm used for calculating digests for content-addressing
   * within the OCFL Object and for the Inventory Digest.
   * This MUST be the algorithm used in the manifest and state blocks
   */
  digestAlgorithm: ContentAlgorithm;
  /** The version directory name of the most recent version of the object. */
  head: string;
  manifest: InventoryDigests;
  versions: {
    [key: string]: InventoryVersion;
  };
  fixity?: {
    [key: string]: {
      [key: string]: string[];
    };
  };
  /**
   * The name of the designated content directory within the version directories.
   * @defaultValue content
   */
  contentDirectory?: string;
}

export type EncodingOptions = BufferEncoding | { encoding: BufferEncoding; [key: string]: unknown };
export type BinaryOptions = { encoding?: null | undefined; [key: string]: unknown };

/**
 * Content for a transaction's `write()`. An async iterable covers a Node `Readable`, a web `ReadableStream` and
 * an async generator.
 */
export type WriteFileData = string | ArrayBufferView | ArrayBuffer | Blob | AsyncIterable<string | ArrayBufferView | ArrayBuffer>;

export type OcflVersion = '1.0' | '1.1';

/** The parameters of each layout this library implements, by official extension name. */
export interface OcflLayoutParameters {
  '000N-path-direct-storage-layout': PathDirectStorageLayoutConfig;
  '0002-flat-direct-storage-layout': Record<never, never>;
  '0003-hash-and-id-n-tuple-storage-layout': HashAndIdNTupleStorageLayoutConfig;
  '0004-hashed-n-tuple-storage-layout': HashedNTupleStorageLayoutConfig;
}

/** The official extension name of a layout this library implements. */
export type OcflLayoutName = keyof OcflLayoutParameters;

/** An official layout name along with that layout's parameters; a union over every layout by default. */
export type OcflLayoutConfig<N extends OcflLayoutName = OcflLayoutName> = N extends OcflLayoutName ? { extensionName: N } & OcflLayoutParameters[N] : never;

/** A storage layout: its official name, its effective parameters (defaults included), and its mapping; a union over every layout by default, narrowed by `name`. */
export type OcflStorageLayout<N extends OcflLayoutName = OcflLayoutName> = N extends OcflLayoutName
  ? {
      readonly name: N;
      readonly parameters: Readonly<Required<OcflLayoutParameters[N]>>;
      /**
       * Map an object identifier to a path
       * @param id - The identifier of the OCFL Object
       */
      map(id: string): string;
    }
  : never;

/** A storage layout to create a storage root with: its extension name plus any parameters, which default as its extension spec says. */
export type LayoutConfig = FlatDirectLayoutConfig | HashAndIdNTupleLayoutConfig | HashedNTupleLayoutConfig | PathDirectLayoutConfig;

/** A storage root's layout: a {@link LayoutConfig} with every parameter present. */
export type Layout = Readonly<Required<LayoutConfig>>;

/** Object directories named by their id, directly in the storage root. */
export interface FlatDirectLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0002-flat-direct-storage-layout';
}

/** Object directories named by their encoded id, nested under pieces of the id's digest. */
export interface HashAndIdNTupleLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0003-hash-and-id-n-tuple-storage-layout';
  /** Algorithm used to hash the id. Defaults to `sha256`. */
  digestAlgorithm?: string;
  /** Characters of the digest in each directory level. Defaults to 3. */
  tupleSize?: number;
  /** Number of directory levels. Defaults to 3. */
  numberOfTuples?: number;
}

/** Object directories named by their id's digest, nested under pieces of it. */
export interface HashedNTupleLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '0004-hashed-n-tuple-storage-layout';
  /** Algorithm used to hash the id. Defaults to `sha256`. */
  digestAlgorithm?: string;
  /** Characters of the digest in each directory level. Defaults to 3. */
  tupleSize?: number;
  /** Number of directory levels. Defaults to 3. */
  numberOfTuples?: number;
  /** Name the object directory with only the rest of the digest. Defaults to `false`. */
  shortObjectRoot?: boolean;
}

/** Object directories at the path spelled by their id. */
export interface PathDirectLayoutConfig {
  /** Name of the layout's OCFL extension. */
  extensionName: '000N-path-direct-storage-layout';
  /** Leave the id's URI scheme out of the path. Defaults to `false`. */
  omitScheme?: boolean;
  /** Pairs of text to find in the id and what to put in its place. Defaults to none. */
  replace?: [find: string, replacement: string][];
  /** Text added to the end of the object directory's path. Defaults to `/__object__`. */
  suffix?: string;
}

/** Configuration options for an OCFL storage root and the objects opened through it. */
export type OcflStorageConfig = {
  /** Absolute path to the ocfl storage root. */
  root: string;
  /**
   * A layout that identifies an arrangement of directories and OCFL objects under the storage root,
   * as an official extension name or `{ extensionName, ...params }`. Anything else throws `UNSUPPORTED_LAYOUT`,
   * and parameters the layout rejects throw `INVALID_LAYOUT_CONFIG`.
   * Only used to create a storage root: loading one always takes the layout the root declares.
   */
  layout?: OcflLayoutName | OcflLayoutConfig | undefined;
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: ContentAlgorithm | undefined;
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string | undefined;
};

/** @internal */
export type OcflObjectConfig = {
  /** Absolute path to the ocfl object root. */
  root: string;
  /** Absolute path to the storage root holding the object. */
  storageRoot: string;
  /** Absolute path where the object's updates are assembled, inside its storage root's workspace. */
  workspace: string;
  /** Identifier for the object.  Only be used in a newly created object. */
  id?: string | undefined;
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: ContentAlgorithm | undefined;
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string | undefined;
  /** Ocfl version. Only applies to a newly created object. */
  ocflVersion: OcflVersion;
};
