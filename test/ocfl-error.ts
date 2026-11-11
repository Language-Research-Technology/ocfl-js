import { OcflError, type OcflErrorCode } from '../src/index.ts';

/** `assert.rejects` matcher for an `OcflError` with `code`, and with `ocflCode` when given */
export const ocflError = (code: OcflErrorCode, ocflCode?: string) => (e: unknown) =>
  e instanceof OcflError && e.code === code && (ocflCode === undefined || e.ocflCode === ocflCode);
