import { inspect, isDeepStrictEqual } from 'node:util';
import { OcflError } from './error.ts';
import type { OcflLayoutName } from './types.ts';

/** A layout's config as callers and config.json give it, before any checking */
type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };

const typeName = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value);

/** `defaults` with the parameters `config` sets, and the names of those parameters */
function mergeParameters(defaults: object | undefined, config: OcflExtensionConfig = {}): { parameters: OcflExtensionConfig; setNames: string[] } {
  const parameters: OcflExtensionConfig = { ...defaults };
  const setNames: string[] = [];
  for (const name of Object.keys(config)) {
    if (Object.hasOwn(parameters, name)) {
      parameters[name] = config[name];
      setNames.push(name);
    }
  }
  return { parameters, setNames };
}

abstract class BuiltInLayout<C extends object = object> {
  /** Official extension name */
  abstract readonly name: OcflLayoutName;
  abstract readonly description: string;
  /** Effective parameters, defaults included */
  readonly parameters: Readonly<C>;
  /** Names of the parameters the caller or config.json set, which config.json records */
  readonly #setNames: string[];

  constructor(config?: OcflExtensionConfig, defaultConfig?: C) {
    const { parameters, setNames } = mergeParameters(defaultConfig, config);
    for (const name of setNames) {
      const expected = typeName((defaultConfig as OcflExtensionConfig)[name]);
      if (typeName(parameters[name]) !== expected) {
        throw new OcflError(
          'INVALID_LAYOUT_CONFIG',
          `Layout parameter ${name} must be ${/^[aeiou]/.test(expected) ? 'an' : 'a'} ${expected}, not ${inspect(parameters[name])}.`,
        );
      }
    }
    this.parameters = Object.freeze(parameters) as Readonly<C>;
    this.#setNames = setNames;
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

/** Names of the parameters in `expected` whose values differ in `actual` */
function differingParameters(actual: OcflExtensionConfig, expected: OcflExtensionConfig): string[] {
  return Object.keys(expected).filter((name) => !isDeepStrictEqual(actual[name], expected[name]));
}

export { BuiltInLayout, differingParameters, type OcflExtensionConfig };
