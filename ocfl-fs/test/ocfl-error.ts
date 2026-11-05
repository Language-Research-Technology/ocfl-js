import { OcflError, type OcflErrorCode } from '../src/index.ts';

/** `assert.rejects` matcher for an `OcflError` re-exported by ocfl-fs, with `code` */
export const ocflError = (code: OcflErrorCode) => (e: unknown) => e instanceof OcflError && e.code === code;
