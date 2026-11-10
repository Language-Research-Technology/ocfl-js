import { inspect, isDeepStrictEqual } from 'node:util';
import { OcflError } from './error.ts';
import type { OcflLayoutName } from './types.ts';

/** A layout's config as callers and config.json give it, before any checking */
type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };

/** Parameter values as config.json stores them, which can't represent a RegExp */
const asStored = (value: unknown) => JSON.parse(JSON.stringify({ value }));

const typeName = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value);

abstract class BuiltInLayout<C extends object = object> {
  /** Official extension name */
  abstract readonly name: OcflLayoutName;
  abstract readonly description: string;
  /** Effective parameters, defaults included */
  readonly parameters: Readonly<C>;
  /** Names of the parameters the caller or config.json set, which config.json records */
  readonly #setNames: string[] = [];
  readonly #defaults: Readonly<OcflExtensionConfig>;

  /** @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if a parameter's type differs from its default's; `undefined` means the default */
  constructor(config?: OcflExtensionConfig, defaultConfig?: C) {
    this.#defaults = defaultConfig ?? {};
    const parameters: OcflExtensionConfig = { ...defaultConfig };
    if (typeof config === 'object' && defaultConfig) {
      for (const k in config) {
        if (Object.hasOwn(defaultConfig, k) && config[k] !== undefined) {
          const expected = typeName(parameters[k]);
          if (typeName(config[k]) !== expected) {
            throw new OcflError(
              'INVALID_LAYOUT_CONFIG',
              `Layout parameter ${k} must be a${expected === 'array' ? 'n' : ''} ${expected}, not ${inspect(config[k])}.`,
            );
          }
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

  /** Names of the parameters whose values, as config.json stores them, differ from those in `stored`, defaults included */
  differencesFromStored(stored: OcflExtensionConfig | undefined): string[] {
    const actual = this.parameters as OcflExtensionConfig;
    const expected: OcflExtensionConfig = { ...this.#defaults, ...stored };
    return Object.keys(actual).filter((name) => !isDeepStrictEqual(asStored(actual[name]), asStored(expected[name])));
  }

  abstract map(id: string): string;
}

export { BuiltInLayout, type OcflExtensionConfig };
