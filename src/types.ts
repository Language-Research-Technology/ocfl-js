/** A digest algorithm OCFL allows for content addressing */
export type ContentAlgorithm = 'sha256' | 'sha512';

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

export type OcflVersion = '1.0' | '1.1';

/** A storage layout to create a storage root with: its extension name plus any parameters, which default as its extension spec says. */
export type LayoutConfig = FlatDirectLayoutConfig | HashAndIdNTupleLayoutConfig | HashedNTupleLayoutConfig | PathDirectLayoutConfig;

/** The official extension name of a layout this library implements. */
export type LayoutName = LayoutConfig['extensionName'];

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
  replace?: readonly (readonly [find: string, replacement: string])[];
  /** Text added to the end of the object directory's path. Defaults to `/__object__`. */
  suffix?: string;
}
