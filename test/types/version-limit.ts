import type { OcflError, OcflErrorCode } from '../../src/index.ts';

export function versionLimitIsAnErrorCode(error: OcflError): OcflErrorCode[] {
  const code: OcflErrorCode = 'VERSION_LIMIT_REACHED';
  // @ts-expect-error not a code
  const misspelt: OcflErrorCode = 'VERSION_LIMIT_REACHD';
  if (error.code === 'VERSION_LIMIT_REACHED') {
    const narrowed: 'VERSION_LIMIT_REACHED' = error.code;
    return [code, misspelt, narrowed];
  }
  return [code, misspelt];
}
