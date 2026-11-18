class VersionNumber {
  readonly value: number;
  readonly zeroPaddingLength: number | undefined;
  private constructor(num: number, zeroPaddingLength?: number) {
    this.value = num;
    this.zeroPaddingLength = zeroPaddingLength;
  }
  toString(): string {
    return `v${this.zeroPaddingLength ? `${this.value}`.padStart(this.zeroPaddingLength, '0') : this.value}`;
  }
  /** The version after this one, or `undefined` if its name, padded, wouldn't start with a zero (E011) */
  next(): VersionNumber | undefined {
    const next = new VersionNumber(this.value + 1, this.zeroPaddingLength);
    if (this.zeroPaddingLength && `${next.value}`.length >= this.zeroPaddingLength) {
      return undefined;
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

export { isVersionName, VersionNumber };
