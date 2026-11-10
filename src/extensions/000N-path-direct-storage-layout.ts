import path from 'node:path';
import { inspect } from 'node:util';
import { OcflError } from '../error.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';

export type PathDirectStorageLayoutConfig = {
  omitScheme?: boolean;
  replace?: [string, string][];
  suffix?: string;
};

const isReplacePair = (pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string';

const DefaultConfig: Required<PathDirectStorageLayoutConfig> = {
  omitScheme: false,
  replace: [],
  suffix: '/__object__',
};

/** Whether `p` has a segment that `path.join` or the URL parser would resolve away, such as `..`, `%2e` or `.\t.` */
function hasDotSegment(p: string): boolean {
  return p
    .replace(/[\t\n\r]/g, '')
    .split(/[/\\]/)
    .some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

class PathDirectStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name = '000N-path-direct-storage-layout';
  readonly description = 'OCFL object identifiers are used directly as the path.';

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    const invalid = this.parameters.replace.find((pair) => !isReplacePair(pair));
    if (invalid !== undefined) {
      throw new OcflError('INVALID_LAYOUT_CONFIG', `Each replace entry must be a [pattern, replacement] pair of strings, not ${inspect(invalid)}.`);
    }
    if (hasDotSegment(this.parameters.suffix)) {
      throw new OcflError('INVALID_LAYOUT_CONFIG', `The suffix '${this.parameters.suffix}' has a . or .. segment.`);
    }
  }

  map(id: string): string {
    var suffix = this.parameters.suffix;
    if (suffix && id.endsWith(suffix)) {
      throw new OcflError('ID_INCOMPATIBLE_WITH_LAYOUT', `Identifier cannot end with '${suffix}'`);
    }
    let replaced = id ?? '';
    for (const r of this.parameters.replace) {
      replaced = replaced.replace(r[0], r[1]);
    }
    let p = replaced;
    const u = URL.parse(replaced);
    let afterScheme = replaced;
    if (u) {
      afterScheme = replaced.slice(u.protocol.length);
      const parts = [];
      if (!this.parameters.omitScheme && u.protocol !== 'file:') {
        parts.push(u.protocol.replace(':', ''));
      }
      if (u.hostname) {
        parts.push(u.hostname.replace(',', '_').replace(';', '/'));
      }
      p = `${parts.join('_')}/${u.pathname}${u.search}${u.hash}`;
    }
    // the URL parser resolves dot segments in the id, and rewriting the hostname can add one
    if (hasDotSegment(afterScheme) || hasDotSegment(p)) {
      throw new OcflError(
        'ID_INCOMPATIBLE_WITH_LAYOUT',
        `The object id <${id}> is incompatible with layout extension ${this.name} because it has a . or .. segment.`,
      );
    }
    p = path.join(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return path.join(p, this.parameters.suffix);
    //if (/^\w+:/.test(id)) {
  }
}

export { PathDirectStorageLayout };
