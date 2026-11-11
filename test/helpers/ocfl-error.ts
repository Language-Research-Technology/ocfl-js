import assert from 'node:assert';
import { OcflError, type OcflErrorCode } from '../../src/index.ts';

/** `assert.rejects` matcher for an `OcflError` with `code`, and with `ocflCode` when given */
export const ocflError = (code: OcflErrorCode, ocflCode?: string) => (e: unknown) =>
  e instanceof OcflError && e.code === code && (ocflCode === undefined || e.ocflCode === ocflCode);

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
