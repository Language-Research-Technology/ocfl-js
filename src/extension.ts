import { isDeepStrictEqual } from 'node:util';
import type { OcflExtensionConfig } from './types.ts';

abstract class BuiltInLayout<C extends object = object> implements OcflStorageLayout {
  /** Official extension name */
  abstract readonly name: string;
  abstract readonly description: string;
  parameters: C;

  constructor(config?: OcflExtensionConfig, defaultConfig?: C) {
    this.parameters = typeof defaultConfig === 'object' ? Object.create(defaultConfig) : {};
    if (typeof config === 'object' && defaultConfig) {
      for (const k in config) {
        if (k in defaultConfig) {
          (this.parameters as OcflExtensionConfig)[k] = config[k];
        }
      }
    }
  }

  /** Return all the parameters in which the value has been set to non-default value */
  get config(): OcflExtensionConfig | undefined {
    const paramNames = Object.keys(this.parameters);
    if (paramNames.length === 0) {
      return undefined;
    }
    const params: OcflExtensionConfig = { extensionName: this.name };
    for (const name of paramNames) {
      params[name] = this.get(name);
    }
    return params;
  }

  // biome-ignore lint/suspicious/noExplicitAny: parameter values are extension specific
  get(param: string): any {
    return (this.parameters as OcflExtensionConfig)[param];
  }

  abstract map(id: string): string;
}

/** Maps object identifiers to paths, with or without a storage root. */
interface OcflStorageLayout {
  /**
   * Get the specified parameter value
   * @param param - The extension parameter name
   */
  // biome-ignore lint/suspicious/noExplicitAny: parameter values are extension specific
  get(param: string): any;
  /**
   * Map an object identifier to a path
   * @param id - The identifier of the OCFL Object
   */
  map(id: string): string;
}

/** Parameter values as config.json stores them, which can't represent a RegExp */
const asStored = (value: unknown) => JSON.parse(JSON.stringify({ value }));

/** Names of the parameters of `reference` whose effective values, defaults included, differ in `extension` */
function differingParameters(extension: BuiltInLayout, reference: BuiltInLayout) {
  const names: string[] = [];
  // for...in includes the defaults inherited from the parameters prototype
  for (const name in reference.parameters) {
    if (!isDeepStrictEqual(asStored(extension.get(name)), asStored(reference.get(name)))) {
      names.push(name);
    }
  }
  return names;
}

export { BuiltInLayout, differingParameters, type OcflStorageLayout };
