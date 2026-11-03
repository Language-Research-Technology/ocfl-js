import { NotImplementedError } from './error.ts';
import type { StorageLayout } from './extensions/index.ts';
import type { OcflExtensionConfig } from './types.ts';

/** Index by Registered extension name */
const extensionByName: { [name: string]: typeof OcflExtension } = {};
/** Index by extension class name */
const extensionByClassName: { [name: string]: typeof OcflExtension } = {};

const storageLayout: { [className: string]: typeof OcflStorageLayout } = {};

type ExtensionConstructor<T> = new (config?: OcflExtensionConfig) => T;

class OcflExtension<C extends object = OcflExtensionConfig> {
  static #object: { [name: string]: typeof OcflExtension } = {};
  static #storage: { [name: string]: typeof OcflExtension } = {};

  parameters: C;

  /**
   * Get an object-level extension
   * @param name - A registered extension name
   */
  static object(name: string) {
    return OcflExtension.#object[name];
  }

  /**
   * Get an storage-level extension
   * @param name - A registered extension name
   */
  static storage(name: string) {
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
  static register(extensionClass: typeof OcflExtension = this) {
    const name = extensionClass.NAME;
    extensionByName[name] = extensionClass;
    extensionByClassName[extensionClass.name] = extensionClass;
    import('./index.ts').then((ocfl) => extensionClass.setup(ocfl));
  }

  /**
   * Create an instance of the extension
   */
  static create<T extends OcflExtension<object>>(this: ExtensionConstructor<T>, config?: OcflExtensionConfig): T {
    const name = config?.extensionName;
    if (!name || (OcflExtension as unknown as typeof OcflExtension).NAME === name) {
      return new this(config);
    }
    return OcflExtension.class(name).create(config) as T;
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
    if (paramNames.length > 0) {
      const params: OcflExtensionConfig = { extensionName: this.name };
      for (const name of paramNames) {
        params[name] = this.get(name);
      }
      return params;
    }
  }

  get p() {
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
  set(param: string, value: unknown) {
    if (param in this.parameters) {
      (this.parameters as OcflExtensionConfig)[param] = value;
    }
  }
}

class OcflStorageLayout<C extends object = OcflExtensionConfig> extends OcflExtension<C> {
  static get layout(): StorageLayout {
    return storageLayout as unknown as StorageLayout;
  }

  static class(name: string): typeof OcflStorageLayout | undefined {
    const c = super.class(name);
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
  static register(extensionClass: typeof OcflStorageLayout = this) {
    super.register(extensionClass);
    storageLayout[extensionClass.name] = extensionClass;
  }

  static get forStorage() {
    return true;
  }

  async validate() {}

  /**
   * Map an object identifier to a path
   * @param id - The identifier of the OCFL Object
   */
  map(_id: string): string {
    throw new NotImplementedError();
  }
}

export { OcflExtension, OcflStorageLayout };
