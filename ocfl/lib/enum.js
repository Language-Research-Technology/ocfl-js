/**
 * Enumeration tool for working with a set of options 
 * @module enum
 */

/**
 * Create enumeration type by passing the class to the constructor 
 * defining the name and value of each constant as static fields.
 * @template V
 */
class Enum {
  /** @type {string} */
  #name;
  /** @type {V} */
  #value;

  /**
   * Return an existing constant that represents the specified value
   * @type {<T extends typeof Enum>(this: T, value: any) => InstanceType<T>}
   */
  static of = function (value, c=this) {
    //if (value instanceof c) return value;
    for (let name in c) {
      if (c[name].value === value) return c[name];
    }
  }

  /**
   * Check if the Enum type contains an Enum instance
   * @param {Enum} instance 
   */
  static has(instance) {
    for (let name in this) {
      if (this[name] === instance) return true;
    }
    return false;
  }

  static ofOrdinal(index, c=this) {
    return c['_enums'][index];
  }

  static freeze(c=this) {
    return Object.freeze(c);
  }

  static size(c=this) {
    return c['_enums'].length;
  }

  static [Symbol.iterator]() {
    return this['_enums'][Symbol.iterator]();
  }

  /** 
   * @param {V} [value]
   */
  constructor(value) {
    let c = this.constructor;
    if (!Object.hasOwn(c, '_enums')) {
      let p = Object.getPrototypeOf(c);
      Object.defineProperty(c, '_enums', { value: p['_enums']?.slice(0) ?? [] });
    }
    this.#value = value;
    this.ordinal = c['_enums'].length;
    c['_enums'].push(this);
    Object.freeze(this);
  }

  get name() {
    if (!this.#name) {
      let ec = this.constructor;
      for (let key in ec) {
        if (ec[key] === this) {
          this.#name = key;
          break;
        }
      }
    }
    return this.#name;
  }

  get value() {
    return this.#value ?? this.name;
  }

  toString() {
    return this.value?.toString();
  }

}
module.exports = { Enum };