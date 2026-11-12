// Each `<!-- example: path -->` marker in the README must be followed by a fenced block identical to that file,
// so the README's examples are the type-checked ones under src/examples.
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../../', import.meta.url);
const read = async (path: string) => (await readFile(new URL(path, repoRoot), 'utf8')).replaceAll('\r\n', '\n');

const readme = await read('README.md');
const markers = [...readme.matchAll(/<!-- example: (\S+) -->(?:\n+```(?:ts|typescript)\n([\s\S]*?\n)```(?=\n|$))?/g)];

if (markers.length === 0) {
  console.error('README.md has no `<!-- example: path -->` marker');
  process.exit(1);
}

let failed = false;
for (const [, path = '', block] of markers) {
  if (block === undefined) {
    console.error(`README.md: the marker for ${path} isn't followed by a \`\`\`ts block.`);
    failed = true;
  } else if (block !== (await read(path))) {
    console.error(`README.md: the block after the marker for ${path} doesn't match that file. Copy the file into the README.`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log(`README.md: ${markers.length} example(s) match`);
