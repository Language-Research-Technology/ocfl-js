import { inspect } from 'node:util';
import { OcflError } from '../error.ts';
import type { BuiltInLayout } from '../extension.ts';
import type { OcflExtensionConfig, OcflLayoutConfig, OcflLayoutName } from '../types.ts';
import { PathDirectStorageLayout } from './000N-path-direct-storage-layout.ts';
import { FlatDirectStorageLayout } from './0002-flat-direct-storage-layout.ts';
import { HashAndIdNTupleStorageLayout } from './0003-hash-and-id-n-tuple-storage-layout.ts';
import { HashedNTupleStorageLayout } from './0004-hashed-n-tuple-storage-layout.ts';

type LayoutClass = new (config?: OcflExtensionConfig) => BuiltInLayout;

// Configs arrive unchecked, from callers and config.json; each layout keeps only its own parameters
const BUILT_IN_LAYOUTS = {
  '000N-path-direct-storage-layout': PathDirectStorageLayout,
  '0002-flat-direct-storage-layout': FlatDirectStorageLayout,
  '0003-hash-and-id-n-tuple-storage-layout': HashAndIdNTupleStorageLayout,
  '0004-hashed-n-tuple-storage-layout': HashedNTupleStorageLayout,
} satisfies Record<OcflLayoutName, unknown> as Record<OcflLayoutName, LayoutClass>;

/** @throws {OcflError} `UNSUPPORTED_LAYOUT` if the library doesn't implement the layout */
function supportedLayoutClass(name: unknown): LayoutClass {
  if (typeof name !== 'string') {
    throw new OcflError('UNSUPPORTED_LAYOUT', `A layout name must be a string, not ${inspect(name)}.`);
  }
  if (!Object.hasOwn(BUILT_IN_LAYOUTS, name)) {
    throw new OcflError('UNSUPPORTED_LAYOUT', `Layout "${name}" is not supported.`);
  }
  return BUILT_IN_LAYOUTS[name as OcflLayoutName];
}

/** Create the layout chosen by an official extension name or `{ extensionName, ...params }` */
function createLayout(selection: OcflLayoutName | OcflLayoutConfig): BuiltInLayout {
  const name = typeof selection === 'string' ? selection : selection?.extensionName;
  if (typeof name !== 'string') {
    throw new OcflError('UNSUPPORTED_LAYOUT', 'A layout must be an official extension name or a config object with an extensionName.');
  }
  const layoutClass = supportedLayoutClass(name);
  return new layoutClass(typeof selection === 'string' ? undefined : selection);
}

export { createLayout, supportedLayoutClass };
