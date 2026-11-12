import { inspect } from 'node:util';
import * as Hashing from '../digest.ts';

const MAX_TUPLE_PARAMETER = 32;

/** The parameters the 0003 and 0004 layouts share */
interface NTupleParameters {
  digestAlgorithm: string;
  tupleSize: number;
  numberOfTuples: number;
}

function checkTupleParameter(name: string, value: number) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TUPLE_PARAMETER) {
    throw new TypeError(`Layout parameter ${name} must be an integer from 0 to ${MAX_TUPLE_PARAMETER}, not ${inspect(value)}.`);
  }
}

/**
 * Check the parameters the 0003 and 0004 layouts share
 * @returns The length of the hex encoded digest
 * @throws `TypeError` if a parameter breaks the extension's constraints
 */
function checkNTupleParameters({ digestAlgorithm, tupleSize, numberOfTuples }: NTupleParameters): number {
  const digestLength = Hashing.getHexDigestLength(digestAlgorithm);
  if (!digestLength) {
    throw new TypeError(`Layout parameter digestAlgorithm must name a supported digest algorithm, not ${inspect(digestAlgorithm)}.`);
  }
  checkTupleParameter('tupleSize', tupleSize);
  checkTupleParameter('numberOfTuples', numberOfTuples);
  if ((tupleSize === 0) !== (numberOfTuples === 0)) {
    throw new TypeError(`tupleSize and numberOfTuples must both be 0 if either is, not ${tupleSize} and ${numberOfTuples}.`);
  }
  if (tupleSize * numberOfTuples > digestLength) {
    throw new TypeError(
      `Product of numberOfTuples and tupleSize, ${numberOfTuples * tupleSize}, is greater than the ${digestLength} characters in the hex encoded ${digestAlgorithm} digest.`,
    );
  }
  return digestLength;
}

export { checkNTupleParameters };
