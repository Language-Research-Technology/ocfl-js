import { isDeepStrictEqual } from 'node:util';
import { NotImplementedError, OcflError } from './error.ts';
import type { OcflExtensionConfig } from './types.ts';

/** Index by Registered extension name */
const extensionByName: { [name: string]: typeof OcflExtension } = {};

const storageLayout: { [className: string]: typeof OcflStorageLayout } = {};

type ExtensionConstructor<T> = new (config?: OcflExtensionConfig) => T;

class OcflExtension<C extends object = object> {
  parameters: C;

  /** List all registered extension classes */
  static get classes(): (typeof OcflExtension)[] {
    return Object.values(extensionByName);
  }

  /**
   * Find a registered extension with the specified name
   * @param name - registered extension name
   * @returns the extension class
   */
  static class(name: string): typeof OcflExtension | undefined {
    return extensionByName[name];
  }

  /**
   * Register an extension
   */
  // biome-ignore lint/complexity/noThisInStatic: defaults to the subclass register() is called on
  static register(extensionClass: typeof OcflExtension = this) {
    const name = extensionClass.NAME;
    extensionByName[name] = extensionClass;
    import('./index.ts').then((ocfl) => extensionClass.setup(ocfl));
  }

  /**
   * Create an instance of the extension
   */
  static create<T extends OcflExtension>(this: ExtensionConstructor<T>, config?: OcflExtensionConfig): T {
    const name = config?.extensionName;
    // biome-ignore lint/complexity/noThisInStatic: must be the subclass create() is called on, or it recurses
    if (!name || (this as unknown as typeof OcflExtension).NAME === name) {
      return new this(config);
    }
    const extensionClass = OcflExtension.class(name);
    if (!extensionClass) {
      throw new Error(`Extension "${name}" is not supported.`);
    }
    return extensionClass.create(config) as T;
  }

  static get NAME() {
    return '0000-example-extension';
  }
  static get DESCRIPTION() {
    return 'Example extension';
  }
  static async setup(_ocfl: typeof import('./index.ts')): Promise<void> {}

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

  /** Extension registered name */
  get name(): string {
    return (this.constructor as typeof OcflExtension).NAME;
  }
  get description(): string {
    return (this.constructor as typeof OcflExtension).DESCRIPTION;
  }
  get version() {
    return '1.0';
  }

  /**
   * Get the specified parameter value
   * @param param - The extension parameter name
   */
  // biome-ignore lint/suspicious/noExplicitAny: parameter values are extension specific
  get(param: string): any {
    return (this.parameters as OcflExtensionConfig)[param];
  }

  /**
   * Set the specified parameter value
   * @param param - The extension parameter name
   * @param value - The extension parameter value
   */
  set(param: string, value: unknown) {
    if (param in this.parameters) {
      (this.parameters as OcflExtensionConfig)[param] = value;
    }
  }
}

class OcflStorageLayout<C extends object = object> extends OcflExtension<C> {
  static class(name: string): typeof OcflStorageLayout | undefined {
    const c = OcflExtension.class(name);
    if (c && c.prototype instanceof OcflStorageLayout) {
      return c as typeof OcflStorageLayout;
    }
  }

  static get classes(): (typeof OcflStorageLayout)[] {
    return Object.values(storageLayout);
  }

  /**
   * Register a storage layout extension
   */
  // biome-ignore lint/complexity/noThisInStatic: defaults to the subclass register() is called on
  static register(extensionClass: typeof OcflStorageLayout = this) {
    OcflExtension.register(extensionClass);
    storageLayout[extensionClass.name] = extensionClass;
  }

  /**
   * Map an object identifier to a path
   * @param id - The identifier of the OCFL Object
   */
  map(_id: string): string {
    throw new NotImplementedError();
  }
}

/** Create the layout chosen by an official extension name or `{ extensionName, ...params }` */
function createLayout(selection: string | OcflExtensionConfig): OcflStorageLayout {
  const name = typeof selection === 'string' ? selection : selection?.extensionName;
  if (typeof name !== 'string') {
    throw new OcflError('UNSUPPORTED_LAYOUT', 'A layout must be an official extension name or a config object with an extensionName.');
  }
  const layoutClass = OcflStorageLayout.class(name);
  if (!layoutClass) {
    throw new OcflError('UNSUPPORTED_LAYOUT', `Layout "${name}" is not supported.`);
  }
  return layoutClass.create(typeof selection === 'string' ? undefined : selection);
}

/** Parameter values as config.json stores them, which can't represent a RegExp */
const asStored = (value: unknown) => JSON.parse(JSON.stringify({ value }));

/** Names of the parameters of `reference` whose effective values, defaults included, differ in `extension` */
function differingParameters(extension: OcflExtension, reference: OcflExtension) {
  const names: string[] = [];
  // for...in includes the defaults inherited from the parameters prototype
  for (const name in reference.parameters) {
    if (name !== 'extensionName' && !isDeepStrictEqual(asStored(extension.get(name)), asStored(reference.get(name)))) {
      names.push(name);
    }
  }
  return names;
}

export { createLayout, differingParameters, OcflExtension, OcflStorageLayout };
