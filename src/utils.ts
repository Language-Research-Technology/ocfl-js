import { inspect } from 'node:util';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `content` parsed as a JSON object, or `undefined` if it isn't one */
function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return isJsonObject(value) ? value : undefined;
  } catch (_error) {
    return undefined;
  }
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** @returns a function that runs the functions given to it, at most `count` at once */
function createLimiter(count: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    if (active < count) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/** `value`, with it and everything nested in it frozen */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param refusal - Starts the message, e.g. `createStorageRoot has no option`
 * @throws `TypeError` naming each key of `object` not in `known`
 */
function rejectUnknownKeys(object: object, known: readonly string[], refusal: string): void {
  const unknown = Object.keys(object).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${refusal} ${unknown.map((key) => inspect(key)).join(' or ')}.`);
  }
}

/**
 * @param call - The call as a caller writes it, e.g. `draft.copy`
 * @param example - Options `call` takes, shown if `options` isn't an object
 * @returns A copy of the own properties of `options`, so each is read once and none is inherited
 * @throws `TypeError` if `options` is given and isn't an object, or has a key not in `known`
 */
function optionsObject(options: unknown, call: string, known: readonly string[], example: string): Record<string, unknown> {
  if (options === undefined) {
    return {};
  }
  if (!isJsonObject(options)) {
    throw new TypeError(`Options must be an object, such as ${example}, not ${inspect(options)}`);
  }
  rejectUnknownKeys(options, known, `${call} has no option`);
  return { ...options };
}

/**
 * Checked by shape, not `instanceof`, so a signal from another realm or a polyfill is accepted, as Node's own APIs accept it
 * @throws `TypeError` if `signal` is given and isn't an `AbortSignal`
 */
function signalOption(signal: unknown): AbortSignal | undefined {
  const candidate = signal as Partial<AbortSignal> | null;
  if (
    signal !== undefined &&
    !(typeof candidate?.aborted === 'boolean' && typeof candidate.throwIfAborted === 'function' && typeof candidate.addEventListener === 'function')
  ) {
    throw new TypeError(`The signal option must be an AbortSignal, not ${inspect(signal)}`);
  }
  return signal as AbortSignal | undefined;
}

/** @throws `TypeError` if the option `name` is given and isn't a function */
function functionOption(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`The ${name} option must be a function, not ${inspect(value)}`);
  }
}

export { createLimiter, deepFreeze, functionOption, isJsonObject, isNonEmptyString, optionsObject, parseJsonObject, rejectUnknownKeys, signalOption };
