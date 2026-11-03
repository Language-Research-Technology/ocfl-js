/**
 * Enumeration tool for working with a set of options
 * @module enumeration
 */

export interface EnumValue {
  readonly name: string;
  readonly ordinal: number;
  toString(): string;
}

const VALUES = Symbol('values');

type EnumType<T extends readonly string[]> = {
  new (name: string, ordinal: number): EnumValue;
  [Symbol.iterator](): Iterator<string>;
} & { readonly [key in T[number]]: EnumValue };

/**
 * Create enumeration type by passing the list of constants as arguments of string
 */
function enumeration<const T extends readonly string[]>(constants: T): EnumType<T> {
  class Enum implements EnumValue {
    #name: string;
    #ordinal: number;
    constructor(name: string, ordinal: number) {
      this.#name = name;
      this.#ordinal = ordinal;
    }
    get name() {
      return this.#name;
    }
    get ordinal() {
      return this.#ordinal;
    }
    toString() {
      return this.name;
    }
    static [Symbol.iterator](): Iterator<string> {
      return constants[Symbol.iterator]();
    }
  }
  const values = constants.map((c, ordinal) => {
    const value = Object.freeze(new Enum(c, ordinal));
    Object.defineProperty(Enum, c, { value, writable: false, enumerable: true });
    return value;
  });
  Object.defineProperty(Enum, VALUES, { value: Object.freeze(values) });
  return Object.freeze(Enum) as unknown as EnumType<T>;
}

/**
 * Return an existing constant that represents the specified value
 */
enumeration.of = <T extends readonly string[]>(type: EnumType<T>, value: unknown): EnumValue | undefined => {
  const t = type as unknown as Record<string, EnumValue>;
  if (value instanceof type && t[value.name]) {
    return value;
  }
  if (typeof value === 'string') {
    if (t[value]) {
      return t[value];
    }
    for (const name in type) {
      if (name.toUpperCase() === value.toUpperCase()) {
        return t[name];
      }
    }
  }
};

const valuesOf = (type: object) => (type as { readonly [VALUES]: readonly EnumValue[] })[VALUES];

/**
 * Return an existing constant based on the index
 */
enumeration.at = <T extends readonly string[]>(type: EnumType<T>, index: number): EnumValue | undefined => valuesOf(type)[index];

enumeration.size = <T extends readonly string[]>(type: EnumType<T>): number => valuesOf(type).length;

export { enumeration };
