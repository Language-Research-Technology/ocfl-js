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
  digestAlgorithm: 'sha256' | 'sha512';
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

export type IDataType = string | ArrayBufferLike | Uint8Array | Uint16Array | Uint32Array;

export interface CommonHasher {
  init: () => CommonHasher;
  update: (data: IDataType) => CommonHasher;
  digest: {
    (outputType: 'binary'): Uint8Array;
    (outputType?: 'hex'): string;
  };
  digestSize: number;
}

export interface MultiHasher {
  multi: true;
  update: (data: IDataType) => MultiHasher;
  digest: {
    (outputType: 'binary'): { [key: string]: Uint8Array };
    (outputType?: 'hex'): { [key: string]: string };
  };
}

export type OcflVersion = '1.0' | '1.1';

export type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };
type OcflStorageLayout = import('./extension.ts').OcflStorageLayout;

/** Configuration options for an OCFL Object. */
export type OcflStorageConfig = {
  /** Absolute path to the ocfl storage root. */
  root: string;
  /** Absolute path to storage workspace directory. */
  workspace?: string;
  /** A layout that identifies an arrangement of directories and OCFL objects under the storage root */
  layout?: OcflStorageLayout | OcflExtensionConfig | string;
  /** A default list of digest algorithm names to be added to the fixity block of objects under this storage. */
  fixityAlgorithms?: string[];
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: 'sha256' | 'sha512';
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string;
  /** Ocfl version. Only applies to a newly created object. @defaultValue {@link OcflConstants.OCFL_VERSION} */
  ocflVersion?: OcflVersion;
};

/** Configuration options for an OCFL Object. */
export type OcflObjectConfig = {
  /** Absolute path to the ocfl object root. */
  root: string;
  /** Absolute path to object workspace directory. */
  workspace?: string;
  /** Identifier for the object.  Only be used in a newly created object. */
  id?: string;
  /** Reference to existing extensions defined outside of the object, such as in the storage root. */
  extensions?: import('./extension.ts').OcflExtension[];
  /** Additional digest algorithms to be calculated for each file and added to the fixity block. */
  fixityAlgorithms?: string[];
  /** Digest algorithm for content-addressing, must use either sha512 or sha256. Defaults to 'sha512'. */
  digestAlgorithm?: 'sha256' | 'sha512';
  /** Content directory name. Only applies to a newly created object. @defaultValue `"content"` */
  contentDirectory?: string;
  /** Ocfl version. Only applies to a newly created object. @defaultValue {@link OcflConstants.OCFL_VERSION} */
  ocflVersion?: OcflVersion;
};
