import { inspect } from 'node:util';
import type { BuiltInLayout, OcflExtensionConfig } from '../extension.ts';
import type { LayoutConfig, OcflLayoutName } from '../types.ts';
import { PathDirectStorageLayout } from './000N-path-direct-storage-layout.ts';
import { FlatDirectStorageLayout } from './0002-flat-direct-storage-layout.ts';
import { HashAndIdNTupleStorageLayout } from './0003-hash-and-id-n-tuple-storage-layout.ts';
import { HashedNTupleStorageLayout } from './0004-hashed-n-tuple-storage-layout.ts';

type LayoutClass = new (config?: OcflExtensionConfig) => BuiltInLayout;

const BUILT_IN_LAYOUTS = {
  '000N-path-direct-storage-layout': PathDirectStorageLayout,
  '0002-flat-direct-storage-layout': FlatDirectStorageLayout,
  '0003-hash-and-id-n-tuple-storage-layout': HashAndIdNTupleStorageLayout,
  '0004-hashed-n-tuple-storage-layout': HashedNTupleStorageLayout,
} satisfies Record<OcflLayoutName, LayoutClass>;

/** The class of the layout with the official extension name `name`, or `undefined` if the library doesn't implement it */
function builtInLayoutClass(name: string): LayoutClass | undefined {
  return Object.hasOwn(BUILT_IN_LAYOUTS, name) ? BUILT_IN_LAYOUTS[name as OcflLayoutName] : undefined;
}

/**
 * Create the layout chosen by `{ extensionName, ...parameters }`
 * @throws `TypeError` if `config` isn't that, the library doesn't implement the layout, or the layout doesn't have or rejects a parameter
 */
function createLayout(config: LayoutConfig): BuiltInLayout {
  // Only its own properties: the name and the parameters must come from the same place
  const own: OcflExtensionConfig = typeof config === 'object' && !Array.isArray(config) ? { ...config } : {};
  const name: unknown = own.extensionName;
  if (typeof name !== 'string') {
    throw new TypeError('A layout must be a config object with an extensionName.');
  }
  const layoutClass = builtInLayoutClass(name);
  if (!layoutClass) {
    throw new TypeError(`Layout "${name}" is not supported.`);
  }
  const layout = new layoutClass(own);
  const unknown = Object.keys(own).filter((parameter) => parameter !== 'extensionName' && !Object.hasOwn(layout.parameters, parameter));
  if (unknown.length > 0) {
    throw new TypeError(`Layout ${name} has no parameter ${unknown.map((parameter) => inspect(parameter)).join(' or ')}.`);
  }
  return layout;
}

export { builtInLayoutClass, createLayout };
