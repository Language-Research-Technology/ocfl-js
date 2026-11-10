import path from 'node:path';
import { OcflConstants } from '../src/constants.ts';
import { OcflObject } from '../src/object.ts';
import type { OcflObjectConfig, OcflVersion } from '../src/types.ts';

const { EXTENSIONS_DIR, WORKSPACE_EXTENSION, OCFL_VERSION } = OcflConstants;

type TestObjectConfig = Omit<OcflObjectConfig, 'storageRoot' | 'workspace' | 'ocflVersion'> & { ocflVersion?: OcflVersion | undefined };

/** An object as a storage root would open it, treating the object's parent directory as that root */
export function testObject({ ocflVersion, ...config }: TestObjectConfig): OcflObject {
  const root = path.resolve(config.root);
  const storageRoot = path.dirname(root);
  const workspace = path.join(storageRoot, EXTENSIONS_DIR, WORKSPACE_EXTENSION, path.basename(root));
  return new OcflObject({ ...config, storageRoot, workspace, ocflVersion: ocflVersion ?? OCFL_VERSION });
}
