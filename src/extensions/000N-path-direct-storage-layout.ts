import path from 'node:path';
import { inspect } from 'node:util';
import { OcflError } from '../error.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';

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

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    for (const pair of this.parameters.replace as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2 || !(typeof pair[0] === 'string' || pair[0] instanceof RegExp) || typeof pair[1] !== 'string') {
        throw new OcflError(
          'INVALID_LAYOUT_CONFIG',
          `Layout parameter replace must hold [pattern, replacement] pairs of a string or RegExp and a string, not ${inspect(pair)}.`,
        );
      }
    }
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
