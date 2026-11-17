import { rejectUnknownKeys } from '../utils.ts';
import { type PathDirectLayoutConfig, PathDirectStorageLayout } from './000N-path-direct-storage-layout.ts';
import { type FlatDirectLayoutConfig, FlatDirectStorageLayout } from './0002-flat-direct-storage-layout.ts';
import { type HashAndIdNTupleLayoutConfig, HashAndIdNTupleStorageLayout } from './0003-hash-and-id-n-tuple-storage-layout.ts';
import { type HashedNTupleLayoutConfig, HashedNTupleStorageLayout } from './0004-hashed-n-tuple-storage-layout.ts';
import type { BuiltInLayout, OcflExtensionConfig } from './built-in-layout.ts';

/** A storage layout to create a storage root with: its extension name plus any parameters, which default as its extension spec says. */
type LayoutConfig = FlatDirectLayoutConfig | HashAndIdNTupleLayoutConfig | HashedNTupleLayoutConfig | PathDirectLayoutConfig;

/** The official extension name of a layout this library implements. */
type LayoutName = LayoutConfig['extensionName'];

/** A storage root's layout: a {@link LayoutConfig} with every parameter present. */
type Layout = Readonly<Required<LayoutConfig>>;

type LayoutClass = new (config?: OcflExtensionConfig) => BuiltInLayout;

const BUILT_IN_LAYOUTS = {
  '000N-path-direct-storage-layout': PathDirectStorageLayout,
  '0002-flat-direct-storage-layout': FlatDirectStorageLayout,
  '0003-hash-and-id-n-tuple-storage-layout': HashAndIdNTupleStorageLayout,
  '0004-hashed-n-tuple-storage-layout': HashedNTupleStorageLayout,
} satisfies Record<LayoutName, LayoutClass>;

/** The storage layouts this library implements, by official extension name, as a list for a message */
const IMPLEMENTED_LAYOUTS: string = Object.keys(BUILT_IN_LAYOUTS)
  .map((name) => `"${name}"`)
  .join(', ');

/** The class of the layout with the official extension name `name`, or `undefined` if the library doesn't implement it */
function builtInLayoutClass(name: string): LayoutClass | undefined {
  return Object.hasOwn(BUILT_IN_LAYOUTS, name) ? BUILT_IN_LAYOUTS[name as LayoutName] : undefined;
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
  rejectUnknownKeys(own, ['extensionName', ...Object.keys(layout.parameters)], `Layout ${name} has no parameter`);
  return layout;
}

export {
  builtInLayoutClass,
  createLayout,
  type FlatDirectLayoutConfig,
  type HashAndIdNTupleLayoutConfig,
  type HashedNTupleLayoutConfig,
  IMPLEMENTED_LAYOUTS,
  type Layout,
  type LayoutConfig,
  type LayoutName,
  type PathDirectLayoutConfig,
};
