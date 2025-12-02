/**
 * Enumeration tool for working with a set of options 
 * @module enumeration
 */

// const COLOR = (c => {
//   let r = /** @type {{[key in (typeof c)[number]]: string}} */({});
//   return r;
// })(/** @type {const} */(['red', 'green', 'blue']));
// COLOR.blue
const constantsSymbol = Symbol('constants');

/**
 * Create enumeration type by passing the list of constants as arguments of string
 * @template {readonly string[]} const T
 * @param {T} constants
 */

function enumeration(constants) {
  class Enum {
    /** @type {string} */
    #name;
    /** @type {number} */
    #ordinal;
    constructor(name, ordinal) {
      this.#name = name;
      this.#ordinal = ordinal;
      //Object.defineProperty(this, 'name', { writable: false, enumerable: true, value: name });
      //Object.defineProperty(this, 'ordinal', { writable: false, enumerable: true, value: ordinal });
    }
    get name() { return this.#name }
    get ordinal() { return this.#ordinal }
    toString() {
      return this.name;
    }
    /** @returns {Iterator<string>} */
    static [Symbol.iterator]() {
      return this[constantsSymbol][Symbol.iterator]();
    }
  }
  /** @typedef { typeof Enum & {[key in T[number]]: Enum} } EnumType */
  let count = 0;
  for (let c of constants) {
    Object.defineProperty(Enum, c, {
      value: Object.freeze(new Enum(c, count++)),
      writable: false,
      enumerable: true
    });
  }
  Object.defineProperty(Enum, constantsSymbol, {
    value: constants,
    writable: false,
    enumerable: false
  });
  return /** @type {EnumType} */(Object.freeze(Enum));
}

/**
 * Return an existing constant that represents the specified value
 * @type {{<T extends abstract new() => any>(type: T, value: any): InstanceType<T>}}
 */
enumeration.of = function (type, value) {
  if (value instanceof type && type[value.name]) return value;
  else if (typeof value === 'string') {
    return type[/**@type {string}*/(value)] || (() => {
      for (let name in type) {
        if (name.toUpperCase() === value.toUpperCase()) return type[name];
      }
    })();
  }
}

/**
 * Return an existing constant based on the index
 * @template T
 * @param {new() => T} type
 * @param {number} index
 * @return {T}
 */
enumeration.at = function (type, index) {
  return type[type[constantsSymbol][index]];
}

enumeration.size = function (type) {
  return type[constantsSymbol].length;
}

exports.enumeration = enumeration;
exports.default = { ...enumeration };
//export default { ...enumeration };