import { inspect } from 'node:util';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** `content` parsed as a JSON object, or `undefined` if it isn't one */
function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
 * @throws `TypeError` naming each key of `object` that `isKnown` refuses
 */
function rejectUnknownKeys(object: object, isKnown: (key: string) => boolean, refusal: string): void {
  const unknown = Object.keys(object).filter((key) => !isKnown(key));
  if (unknown.length > 0) {
    throw new TypeError(`${refusal} ${unknown.map((key) => inspect(key)).join(' or ')}.`);
  }
}

export { createLimiter, deepFreeze, isNonEmptyString, parseJsonObject, rejectUnknownKeys };
