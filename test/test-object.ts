import path from 'node:path';
import { OcflConstants } from '../src/constants.ts';
import { OcflObject } from '../src/object.ts';
import { updateTarget } from '../src/transaction.ts';
import type { OcflObjectConfig, OcflVersion } from '../src/types.ts';

const { OCFL_VERSION } = OcflConstants;

type TestObjectConfig = Omit<OcflObjectConfig, 'storageRoot' | 'workspace' | 'ocflVersion'> & { ocflVersion?: OcflVersion | undefined };

/** An object as a storage root would open it, treating the object's parent directory as that root */
export function testObject({ ocflVersion, ...config }: TestObjectConfig): OcflObject {
  const root = path.resolve(config.root);
  return new OcflObject({ ...config, ...updateTarget(path.dirname(root), root, ocflVersion ?? OCFL_VERSION) });
}
