import { inspect } from 'node:util';
import { type OcflError, ocflError } from './error.ts';
import type { LayoutName } from './types.ts';

/** A layout's config as callers and config.json give it, before any checking */
type OcflExtensionConfig = { extensionName?: string; [key: string]: unknown };

const typeName = (value: unknown) => (Array.isArray(value) ? 'array' : typeof value);

/** @throws `TypeError` if `value` holds anything but plain data */
function ownCopy(name: string, value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`Layout parameter ${name} must hold only strings, numbers, booleans and arrays of them.`, { cause: error });
  }
}

/**
 * `defaults` with the parameters `config` sets, and the names of those parameters. The values are copies, so they can't change under the layout.
 * @throws `TypeError` if a parameter `config` sets holds anything but plain data
 */
function mergeParameters(defaults: object | undefined, config: OcflExtensionConfig = {}): { parameters: OcflExtensionConfig; setNames: string[] } {
  const parameters: OcflExtensionConfig = structuredClone({ ...defaults });
  const setNames: string[] = [];
  for (const name of Object.keys(config)) {
    if (Object.hasOwn(parameters, name) && config[name] !== undefined) {
      parameters[name] = ownCopy(name, config[name]);
      setNames.push(name);
    }
  }
  return { parameters, setNames };
}

abstract class BuiltInLayout<C extends object = object> {
  /** Official extension name */
  abstract readonly name: LayoutName;
  abstract readonly description: string;
  /** Plain text describing a layout that isn't a registered OCFL extension, which a storage root using it carries (OCFL spec §4.5) */
  readonly documentation?: string;
  /** Effective parameters, defaults included */
  readonly parameters: Readonly<C>;
  /** Names of the parameters the caller or config.json set, which config.json records */
  readonly #setNames: string[];

  /** @throws `TypeError` if a parameter `config` sets isn't plain data of the type of its default */
  constructor(config?: OcflExtensionConfig, defaultConfig?: C) {
    const { parameters, setNames } = mergeParameters(defaultConfig, config);
    for (const name of setNames) {
      const expected = typeName((defaultConfig as OcflExtensionConfig)[name]);
      if (typeName(parameters[name]) !== expected) {
        throw new TypeError(`Layout parameter ${name} must be ${/^[aeiou]/.test(expected) ? 'an' : 'a'} ${expected}, not ${inspect(parameters[name])}.`);
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

  /** @param reason - Completes "because …" */
  protected incompatibleId(id: string, reason: string): OcflError {
    return ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `The object id <${id}> is incompatible with the ${this.name} storage layout because ${reason}.`);
  }
}

export { BuiltInLayout, type OcflExtensionConfig };
