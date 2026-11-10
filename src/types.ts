import type { ContentAlgorithm } from './digest.ts';

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
   * @default content
   */
  contentDirectory?: string;
}

export type EncodingOptions = BufferEncoding | { encoding: BufferEncoding; [key: string]: unknown };
export type BinaryOptions = { encoding?: null | undefined; [key: string]: unknown };

export type WriteFileData = string | Uint8Array | DataView | ArrayBuffer | ReadableStream;

export type OcflVersion = '1.0' | '1.1';

export type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };

/** The official extension name of a layout this library implements. */
export type OcflLayoutName =
  | '000N-path-direct-storage-layout'
  | '0002-flat-direct-storage-layout'
  | '0003-hash-and-id-n-tuple-storage-layout'
  | '0004-hashed-n-tuple-storage-layout';

/** An official layout name along with that layout's parameters. */
export type OcflLayoutConfig = { extensionName: OcflLayoutName; [key: string]: unknown };

/** Configuration options for an OCFL Object. */
export type OcflStorageConfig = {
  /** Absolute path to the ocfl storage root. */
  root: string;
  /** Absolute path to storage workspace directory. Each object works in its own subdirectory; use it for one storage root at a time. */
  workspace?: string | undefined;
  /**
   * A layout that identifies an arrangement of directories and OCFL objects under the storage root,
   * as an official extension name or `{ extensionName, ...params }`. Anything else throws `UNSUPPORTED_LAYOUT`.
   * Loading a root that declares a supported layout with a different name or parameters throws `LAYOUT_MISMATCH`,
   * loading one that declares a layout this library doesn't implement throws `UNSUPPORTED_LAYOUT`,
   * and loading one whose `ocfl_layout.json` has no readable `extension` throws `E070`.
   */
  layout?: OcflLayoutName | OcflLayoutConfig | undefined;
  /** A default list of digest algorithm names to be added to the fixity block of objects under this storage. */
  fixityAlgorithms?: string[] | undefined;
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: ContentAlgorithm | undefined;
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string | undefined;
  /**
   * Ocfl version of a newly created storage root and its objects. When loading an existing root, defaults to
   * the root's declared version; `load()` rejects with E081 if this is later than the root's version.
   * @defaultValue `"1.1"`
   */
  ocflVersion?: OcflVersion | undefined;
};

/** Configuration options for an OCFL Object. */
export type OcflObjectConfig = {
  /** Absolute path to the ocfl object root. */
  root: string;
  /** Absolute path to object workspace directory. Use it for one object at a time. */
  workspace?: string | undefined;
  /** Identifier for the object.  Only be used in a newly created object. */
  id?: string | undefined;
  /** Additional digest algorithms to be calculated for each file and added to the fixity block. */
  fixityAlgorithms?: string[] | undefined;
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: ContentAlgorithm | undefined;
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string | undefined;
  /** Ocfl version. Only applies to a newly created object. @defaultValue `"1.1"` */
  ocflVersion?: OcflVersion | undefined;
};
