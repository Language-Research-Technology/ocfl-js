import nodePath from 'node:path';
import { OcflConstants } from './constants.ts';
import { normaliseDigest } from './digest.ts';
import { ocflError } from './error.ts';
import type { OcflObjectInventory } from './inventory.ts';

const { INVENTORY_NAME } = OcflConstants;

class VersionNumber {
  value: number;
  zeroPaddingLength: number | undefined;
  private constructor(num: number, zeroPaddingLength?: number) {
    this.value = num;
    this.zeroPaddingLength = zeroPaddingLength;
  }
  toString(): string {
    return `v${this.zeroPaddingLength ? `${this.value}`.padStart(this.zeroPaddingLength, '0') : this.value}`;
  }
  /** @throws {@link OcflError} `VERSION_LIMIT_REACHED` if the next name, padded, wouldn't start with a zero (E011) */
  next(): VersionNumber {
    const next = new VersionNumber(this.value + 1, this.zeroPaddingLength);
    if (this.zeroPaddingLength && `${next.value}`.length >= this.zeroPaddingLength) {
      throw ocflError(
        'VERSION_LIMIT_REACHED',
        `There can be no version after ${this}: a zero-padded version name must start with a zero (E011), and one of ${this.zeroPaddingLength} digits can't for ${next.value}.`,
      );
    }
    return next;
  }
  previous(): VersionNumber | undefined {
    const n = this.value - 1;
    if (n > 0) {
      return new VersionNumber(n, this.zeroPaddingLength);
    }
  }
  /** @internal */
  static _fromString(versionLabel: string): VersionNumber {
    const label = versionLabel.replace('v', '');
    let zeroPaddingLength: number | undefined;
    if (label.startsWith('0')) {
      zeroPaddingLength = label.length;
    }
    return new VersionNumber(parseInt(label, 10), zeroPaddingLength);
  }

  /**
   * The number of `versionLabel` among `versionNames`, which are padded to one width if any of them has a leading zero
   * @internal
   */
  static _among(versionLabel: string, versionNames: string[]): VersionNumber {
    const padded = versionNames.find((name) => name.startsWith('v0'));
    return new VersionNumber(VersionNumber._fromString(versionLabel).value, padded ? VersionNumber._fromString(padded).zeroPaddingLength : undefined);
  }
}

/** Whether `name` is a version directory name, such as `v1` or `v001` */
function isVersionName(name: string): boolean {
  return /^v(?:[1-9]\d*|0\d*[1-9]\d*)$/.test(name);
}

/** The digest an inventory sidecar records, normalised, if it records one */
function sidecarDigest(sidecar: string | undefined): string | undefined {
  const recorded = sidecar?.match(/\S+/)?.[0];
  return recorded === undefined ? undefined : normaliseDigest(recorded);
}

/** What the sidecar of `inventory` holds, once its digest is known */
function sidecarContent(inventory: OcflObjectInventory): string {
  return `${inventory._digest} ${INVENTORY_NAME}`;
}

/** The root inventory and its sidecar, and where a commit stages each before renaming it into place */
function rootInventoryPaths(objectRoot: string, digestAlgorithm: string): Record<'inventory' | 'sidecar' | 'stagedInventory' | 'stagedSidecar', string> {
  const inventory = nodePath.join(objectRoot, INVENTORY_NAME);
  const sidecar = `${inventory}.${digestAlgorithm}`;
  return { inventory, sidecar, stagedInventory: `${inventory}.tmp`, stagedSidecar: `${sidecar}.tmp` };
}

/** Whether `name` is a staged file of {@link rootInventoryPaths}, for any digest algorithm */
function isStagedRootInventory(name: string): boolean {
  return /^inventory\.json(\.[^.]+)?\.tmp$/.test(name);
}

export { isStagedRootInventory, isVersionName, rootInventoryPaths, sidecarContent, sidecarDigest, VersionNumber };
