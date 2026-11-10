import { inspect } from 'node:util';
import * as Hashing from '../digest.ts';
import { OcflError } from '../error.ts';

const MAX_TUPLE_PARAMETER = 32;

type NTupleParameters = { digestAlgorithm: string; tupleSize: number; numberOfTuples: number };

/**
 * Check the parameters 0003 and 0004 share
 * @returns The length of the hex digest
 * @throws {@link OcflError} `INVALID_LAYOUT_CONFIG` if a parameter is out of range or the tuples don't fit the digest
 */
function checkNTupleParameters({ digestAlgorithm, tupleSize, numberOfTuples }: NTupleParameters): number {
  const digestLength = Hashing.getHexDigestLength(digestAlgorithm);
  if (!digestLength) {
    throw new OcflError('INVALID_LAYOUT_CONFIG', `Layout parameter digestAlgorithm must name a supported digest algorithm, not ${inspect(digestAlgorithm)}.`);
  }
  for (const [name, value] of Object.entries({ tupleSize, numberOfTuples })) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_TUPLE_PARAMETER) {
      throw new OcflError('INVALID_LAYOUT_CONFIG', `Layout parameter ${name} must be an integer from 0 to ${MAX_TUPLE_PARAMETER}, not ${inspect(value)}.`);
    }
  }
  if ((tupleSize === 0) !== (numberOfTuples === 0)) {
    throw new OcflError(
      'INVALID_LAYOUT_CONFIG',
      `Layout parameters tupleSize and numberOfTuples must both be 0 if either is, not ${tupleSize} and ${numberOfTuples}.`,
    );
  }
  if (tupleSize * numberOfTuples > digestLength) {
    throw new OcflError(
      'INVALID_LAYOUT_CONFIG',
      `Layout parameters tupleSize and numberOfTuples must multiply to at most the ${digestLength} characters of a hex ${digestAlgorithm} digest, not ${tupleSize} × ${numberOfTuples}.`,
    );
  }
  return digestLength;
}

export { checkNTupleParameters };
