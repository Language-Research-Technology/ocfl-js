import { NotImplementedError } from './error.ts';
import type { StorageLayout } from './extensions/index.ts';
import type { OcflExtensionConfig } from './types.ts';

/** Index by Registered extension name */
const extensionByName: { [name: string]: typeof OcflExtension } = {};
/** Index by extension class name */
const extensionByClassName: { [name: string]: typeof OcflExtension } = {};

const storageLayout: { [className: string]: typeof OcflStorageLayout } = {};

type ExtensionConstructor<T> = new (config?: OcflExtensionConfig) => T;

class OcflExtension<C extends object = object> {
  static #object: { [name: string]: typeof OcflExtension } = {};
  static #storage: { [name: string]: typeof OcflExtension } = {};

  parameters: C;

  /**
   * Get an object-level extension
   * @param name - A registered extension name
   */
  static object(name: string): typeof OcflExtension | undefined {
    return OcflExtension.#object[name];
  }

  /**
   * Get an storage-level extension
   * @param name - A registered extension name
   */
  static storage(name: string): typeof OcflExtension | undefined {
    return OcflExtension.#storage[name];
  }

  /** List all registered extension classes */
  static get classes(): (typeof OcflExtension)[] {
    return Object.values(extensionByName);
  }

  /**
   * Find a registered extension with the specified name
   * @param name - extension class name or registered extension name
   * @returns the extension class
   */
  static class(name: string): typeof OcflExtension | undefined {
    return extensionByName[name] || extensionByClassName[name];
  }

  /**
   * Register an extension
   */
  // biome-ignore lint/complexity/noThisInStatic: defaults to the subclass register() is called on
  static register(extensionClass: typeof OcflExtension = this): void {
    const name = extensionClass.NAME;
    extensionByName[name] = extensionClass;
    extensionByClassName[extensionClass.name] = extensionClass;
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
    return createByName(OcflExtension, 'Extension', name, config) as T;
  }

  static get forObject() {
    return false;
  }
  static get forStorage() {
    return false;
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

  get p(): C {
    return this.parameters;
  }

  /** Extension registered name */
  get name(): string {
    return (this.constructor as typeof OcflExtension).NAME;
  }
  get description(): string {
    return (this.constructor as typeof OcflExtension).DESCRIPTION;
  }
  get minOcflVersion() {
    return '1.0';
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
  set(param: string, value: unknown): void {
    if (param in this.parameters) {
      (this.parameters as OcflExtensionConfig)[param] = value;
    }
  }
}

class OcflStorageLayout<C extends object = object> extends OcflExtension<C> {
  static get layout(): StorageLayout {
    return storageLayout as unknown as StorageLayout;
  }

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
  static register(extensionClass: typeof OcflStorageLayout = this): void {
    OcflExtension.register(extensionClass);
    storageLayout[extensionClass.name] = extensionClass;
  }

  static get forStorage() {
    return true;
  }

  /**
   * Map an object identifier to a path
   * @param id - The identifier of the OCFL Object
   */
  map(_id: string): string {
    throw new NotImplementedError();
  }
}

type ExtensionRegistry<T> = { class(name: string): { create(config?: OcflExtensionConfig): T } | undefined };

/** Create an instance of the extension registered as `name`, or throw if `registry` has none */
function createByName<T extends OcflExtension>(
  registry: ExtensionRegistry<T>,
  kind: 'Extension' | 'Layout',
  name: string | undefined,
  config?: OcflExtensionConfig,
): T {
  const cls = name ? registry.class(name) : undefined;
  if (!cls) {
    throw new Error(`${kind} "${name}" is not supported.`);
  }
  return cls.create(config);
}

export { createByName, OcflExtension, OcflStorageLayout };
