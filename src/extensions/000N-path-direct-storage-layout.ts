import path from 'node:path';
import { OcflError } from '../error.ts';
import { BuiltInLayout } from '../extension.ts';

export type PathDirectStorageLayoutConfig = {
  omitScheme?: boolean;
  replace?: [string | RegExp, string][];
  suffix?: string;
};

const DefaultConfig: Required<PathDirectStorageLayoutConfig> = {
  omitScheme: false,
  replace: [],
  suffix: '/__object__',
};

class PathDirectStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name = '000N-path-direct-storage-layout';
  readonly description = 'OCFL object identifiers are used directly as the path.';

  constructor(config?: PathDirectStorageLayoutConfig) {
    super(config, DefaultConfig);
  }

  map(id: string): string {
    var suffix = this.parameters.suffix;
    if (suffix && id.endsWith(suffix)) {
      throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `Identifier cannot end with '${suffix}'`);
    }
    var p = id ?? '';
    for (const r of this.parameters.replace) {
      p = p.replace(r[0], r[1]);
    }
    try {
      const u = new URL(p);
      const parts = [];
      if (!this.parameters.omitScheme && u.protocol !== 'file:') {
        parts.push(u.protocol.replace(':', ''));
      }
      if (u.hostname) {
        parts.push(u.hostname.replace(',', '_').replace(';', '/'));
      }
      p = path.join(parts.join('_'), u.pathname + u.search + u.hash);
    } catch (_error) {}
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    return path.join(p, this.parameters.suffix);
    //if (/^\w+:/.test(id)) {
  }
}

export { PathDirectStorageLayout };
