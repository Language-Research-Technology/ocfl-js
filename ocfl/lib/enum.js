/**
 * Enumeration tool for working with a set of options 
 * @module enum
 */
//@ts-check

/**
 * Create enumeration type by extending the Enum class and 
 * defining the name and value of each constant as static fields.
 * @template V
 */
class Enum {
  /** @type {V} */
  #value;

  /**
   * Return an existing constant that represents the specified value
   * @template V
   * @param {V} value
   * @return {Enum.<V>}
   */
  static of(value, c=this) {
    //if (value instanceof c) return value;
    for (let name in c) {
      if (c[name].value === value) return c[name];
    }
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
   * @param {V} value
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
    Object.defineProperty(this, '', {value:{}});
    Object.freeze(this);
  }

  get name() {
    let meta = this[''];
    if (!meta.name) {
      let ec = this.constructor;
      for (let key in ec) {
        if (ec[key] === this) {
          meta.name = key;
          break;
        }
      }
    }
    return meta.name;
  }

  get value() {
    return this.#value ?? this.name;
  }

  toString() {
    return this.value?.toString();
  }

}
module.exports = { Enum };