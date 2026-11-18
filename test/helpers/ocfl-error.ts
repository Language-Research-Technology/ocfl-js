import assert from 'node:assert';
import { OcflError, type OcflErrorCode } from '../../src/index.ts';

/** Fields an `OcflError` must have, where `undefined` means the field must be absent */
export type ErrorFields = { [Name in 'ocflCode' | 'objectId' | 'logicalPath' | 'sourcePath']?: OcflError[Name] | undefined };

function hasFields(e: OcflError, fields: ErrorFields): boolean {
  return Object.entries(fields).every(([name, value]) => (value === undefined ? !(name in e) : e[name as keyof ErrorFields] === value));
}

/** `assert.rejects` matcher for an `OcflError` with `code`, and with `ocflCode`, or `fields`, when given */
export const ocflError =
  (code: OcflErrorCode, expected?: string | ErrorFields) =>
  (e: unknown): boolean => {
    const fields = typeof expected === 'string' ? { ocflCode: expected } : (expected ?? {});
    return e instanceof OcflError && e.code === code && hasFields(e, fields);
  };

/** The rejection of `promise`, which must be an `OcflError`, with `code` when given */
export async function rejection(promise: Promise<unknown>, code?: OcflErrorCode): Promise<OcflError> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof OcflError, String(error));
  if (code !== undefined) {
    assert.strictEqual(error.code, code);
  }
  return error;
}
