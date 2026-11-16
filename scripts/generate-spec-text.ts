import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const text = fs.readFileSync(path.join(root, 'resources/ocfl_1.1.md'), 'utf8');
const source = `// Generated from resources/ocfl_1.1.md by scripts/generate-spec-text.ts. Don't edit; run \`pnpm generate:spec-text\`.
export const SPEC_TEXT: string = ${JSON.stringify(text)};
`;
fs.writeFileSync(path.join(root, 'src/spec-text.ts'), source);
