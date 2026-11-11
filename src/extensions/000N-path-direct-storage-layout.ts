import path from 'node:path';
import { inspect } from 'node:util';
import { ocflError } from '../error.ts';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';
import type { PathDirectLayoutConfig } from '../types.ts';

const isReplacePair = (pair: unknown) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string';

const DefaultConfig: Required<Omit<PathDirectLayoutConfig, 'extensionName'>> = {
  omitScheme: false,
  replace: [],
  suffix: '/__object__',
};

const NAME = '000N-path-direct-storage-layout';

const DOCUMENTATION = `# ${NAME}

A local storage layout extension used by the ocfl-js library (@ocfl/ocfl-fs). It is not a registered OCFL extension.

The path of an OCFL object root is spelled by the object's identifier, so the storage root can be browsed by identifier.

## Parameters

Set in \`extensions/${NAME}/config.json\`. A parameter left out takes its default.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| \`omitScheme\` | boolean | \`${DefaultConfig.omitScheme}\` | Leave the identifier's URI scheme out of the path. |
| \`replace\` | array of \`[find, replacement]\` pairs of strings | \`${JSON.stringify(DefaultConfig.replace)}\` | Text to find in the identifier and what to put in its place. Only the first occurrence of each \`find\` is replaced. |
| \`suffix\` | string | \`${DefaultConfig.suffix}\` | Added to the end of the path. It marks the object root, so that one identifier can be the start of another without one object sitting inside the other. |

## Mapping

1. Each \`replace\` pair is applied to the identifier, in order, as JavaScript's \`String.prototype.replace\` applies a string pattern.
   A \`$\` in a replacement therefore has that function's special meaning, such as \`$&\` for the text found.
2. An identifier that parses as a URL under the WHATWG URL Standard is first normalised as that standard describes:
   the scheme and, for schemes such as \`https\`, the host are lower-cased, and characters such as spaces in the path are percent-encoded.
   It then becomes \`<scheme>_<host>/<path><query><fragment>\`, or \`<scheme>/<path><query><fragment>\` if it has no host.
   The host is the host name only: a port, user name or password in the identifier is left out, so identifiers that differ only in those map to the same path.
   The scheme is left out when \`omitScheme\` is set, and always for a \`file:\` URL. In the host, the first \`,\` becomes \`_\` and the first \`;\` becomes \`/\`.
   Any other identifier is used as it is.
3. Leading, trailing and repeated \`/\` are removed.
4. \`suffix\` is added.

An identifier that ends with \`suffix\`, or has a \`.\` or \`..\` path segment, is refused.

## Examples

With the default parameters:

| Identifier | Object root |
| --- | --- |
| \`arcp://name,corpus/item/1\` | \`arcp_name_corpus/item/1/__object__\` |
| \`https://example.org/a/b\` | \`https_example.org/a/b/__object__\` |
| \`collection/item\` | \`collection/item/__object__\` |
`;

/** Whether `p` has a segment that `path.join` or the URL parser would resolve away, such as `..`, `%2e` or `.\t.` */
function hasDotSegment(p: string): boolean {
  return p
    .replace(/[\t\n\r]/g, '')
    .split(/[/\\]/)
    .some((segment) => /^(\.|%2e){1,2}$/i.test(segment));
}

class PathDirectStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name: typeof NAME = NAME;
  readonly description = 'OCFL object identifiers are used directly as the path.';
  override readonly documentation: string = DOCUMENTATION;

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    const invalid = this.parameters.replace.findIndex((pair) => !isReplacePair(pair));
    if (invalid !== -1) {
      throw new TypeError(`Each replace entry must be a [pattern, replacement] pair of strings, not ${inspect(this.parameters.replace[invalid])}.`);
    }
    if (hasDotSegment(this.parameters.suffix)) {
      throw new TypeError(`The suffix '${this.parameters.suffix}' has a . or .. segment.`);
    }
  }

  map(id: string): string {
    var suffix = this.parameters.suffix;
    if (suffix && id.endsWith(suffix)) {
      throw ocflError('ID_INCOMPATIBLE_WITH_LAYOUT', `Identifier cannot end with '${suffix}'`);
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
      throw ocflError(
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
