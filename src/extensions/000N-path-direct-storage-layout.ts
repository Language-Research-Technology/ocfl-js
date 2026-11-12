import path from 'node:path';
import { inspect } from 'node:util';
import { BuiltInLayout, type OcflExtensionConfig } from '../extension.ts';
import type { PathDirectLayoutConfig } from '../types.ts';
import { hasOverlongSegment, MAX_NAME_BYTES } from '../utils.ts';

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
| \`suffix\` | string | \`${DefaultConfig.suffix}\` | Added to the end of the path, as one or more path segments; leading, trailing and repeated \`/\` in it are ignored. It marks the object root, so that one identifier can be the start of another without one object sitting inside the other. It must have at least one segment, so \`''\` and \`/\` are refused. |

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

An identifier is refused if its last path segments are those of \`suffix\`, or if it has a \`.\` or \`..\` path segment.
So is one whose path, once mapped, has \`suffix\` part-way through: one in which a directory above the object root ends with \`suffix\`,
such as \`a/__object__/b\` with the default parameters. That directory would be the object root of another identifier, so no object root is ever inside another.
These comparisons are of whole path segments, ignoring case and Unicode normalisation form, as a case-insensitive file system names them: \`a/__OBJECT__/b\` is refused too.
So is one whose path, once mapped, has a segment longer than ${MAX_NAME_BYTES} bytes in UTF-8, which file systems cannot name.

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

function trimSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The path segments of `p`, compared as a case-insensitive file system would */
function foldedSegments(p: string): string[] {
  return p
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.normalize('NFC').toLowerCase());
}

class PathDirectStorageLayout extends BuiltInLayout<typeof DefaultConfig> {
  readonly name: typeof NAME = NAME;
  readonly description = 'OCFL object identifiers are used directly as the path.';
  override readonly documentation: string = DOCUMENTATION;
  readonly #suffixPath: string;
  readonly #foldedSuffixSegments: string[];

  constructor(config?: OcflExtensionConfig) {
    super(config, DefaultConfig);
    const invalid = this.parameters.replace.findIndex((pair) => !isReplacePair(pair));
    if (invalid !== -1) {
      throw new TypeError(`Each replace entry must be a [pattern, replacement] pair of strings, not ${inspect(this.parameters.replace[invalid])}.`);
    }
    if (hasDotSegment(this.parameters.suffix)) {
      throw new TypeError(`The suffix '${this.parameters.suffix}' has a . or .. segment.`);
    }
    this.#suffixPath = trimSlashes(path.join('/', this.parameters.suffix));
    if (this.#suffixPath === '') {
      throw new TypeError(`The suffix '${this.parameters.suffix}' has no path segment, so one object root could be inside another.`);
    }
    this.#foldedSuffixSegments = foldedSegments(this.#suffixPath);
  }

  /** Whether the suffix's segments are at index `i` of `segments` */
  #hasSuffixAt(segments: string[], i: number): boolean {
    return i >= 0 && this.#foldedSuffixSegments.every((segment, j) => segments[i + j] === segment);
  }

  map(id: string): string {
    const { suffix } = this.parameters;
    const idSegments = foldedSegments(id);
    if (this.#hasSuffixAt(idSegments, idSegments.length - this.#foldedSuffixSegments.length)) {
      throw this.incompatibleId(id, `it ends with '${suffix}'`);
    }
    let replaced = id;
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
      throw this.incompatibleId(id, 'it has a . or .. segment');
    }
    p = trimSlashes(path.join(p));
    const objectRoot = path.join(p, this.#suffixPath);
    const rootSegments = foldedSegments(objectRoot);
    const lastStartAbove = rootSegments.length - 1 - this.#foldedSuffixSegments.length;
    if (rootSegments.some((_segment, i) => i <= lastStartAbove && this.#hasSuffixAt(rootSegments, i))) {
      throw this.incompatibleId(id, `its path has '${suffix}' part-way through, which would put it inside another object`);
    }
    if (hasOverlongSegment(objectRoot)) {
      throw this.incompatibleId(id, `its path has a segment longer than ${MAX_NAME_BYTES} bytes in UTF-8`);
    }
    return objectRoot;
  }
}

export { PathDirectStorageLayout };
