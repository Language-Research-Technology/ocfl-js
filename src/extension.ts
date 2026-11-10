import { isDeepStrictEqual } from 'node:util';
import type { OcflLayoutName } from './types.ts';

/** A layout's config as callers and config.json give it, before any checking */
type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };

abstract class BuiltInLayout<C extends object = object> {
  /** Official extension name */
  abstract readonly name: OcflLayoutName;
  abstract readonly description: string;
  /** Effective parameters, defaults included */
  readonly parameters: Readonly<C>;
  /** Names of the parameters the caller or config.json set, which config.json records */
  readonly #setNames: string[] = [];

  constructor(config?: OcflExtensionConfig, defaultConfig?: C) {
    const parameters: OcflExtensionConfig = { ...defaultConfig };
    if (typeof config === 'object' && defaultConfig) {
      for (const k in config) {
        if (k in defaultConfig) {
          parameters[k] = config[k];
          this.#setNames.push(k);
        }
      }
    }
    this.parameters = Object.freeze(parameters) as Readonly<C>;
  }

  /** The parameters to record in config.json, or `undefined` if none were set */
  get config(): OcflExtensionConfig | undefined {
    if (this.#setNames.length === 0) {
      return undefined;
    }
    const params: OcflExtensionConfig = { extensionName: this.name };
    for (const name of this.#setNames) {
      params[name] = (this.parameters as OcflExtensionConfig)[name];
    }
    return params;
  }

  abstract map(id: string): string;
}

/** Parameter values as config.json stores them, which can't represent a RegExp */
const asStored = (value: unknown) => JSON.parse(JSON.stringify({ value }));

/** Names of the parameters of `reference` whose effective values, defaults included, differ in `extension` */
function differingParameters(extension: BuiltInLayout, reference: BuiltInLayout): string[] {
  const actual = extension.parameters as OcflExtensionConfig;
  const expected = reference.parameters as OcflExtensionConfig;
  return Object.keys(expected).filter((name) => !isDeepStrictEqual(asStored(actual[name]), asStored(expected[name])));
}

export { BuiltInLayout, differingParameters, type OcflExtensionConfig };
