import { readFile, writeFile } from 'node:fs/promises';

export const glossarySource: URL = new URL('../GLOSSARY.md', import.meta.url);
const glossaryPagePath = new URL('src/content/docs/glossary.md', import.meta.url);

const frontmatter = `---
title: Glossary
description: The terms ocfl-fs and its documentation use, and the words they avoid.
---

<!-- Generated from GLOSSARY.md when the site is built; edit that file instead. -->
`;

export function glossaryPage(source: string): string {
  const text = source.replaceAll('\r\n', '\n');
  if (!text.startsWith('# ')) {
    throw new Error('GLOSSARY.md must start with a `# ` heading, which the Glossary page replaces with its title');
  }
  return text
    .replace(/^# .*\n/, frontmatter)
    .replace(/^\*\*(.+)\*\*:\n/gm, '### $1\n\n')
    .replace(/\n_Avoid_:/g, '\n\n_Avoid_:');
}

// Rewriting an unchanged page would make a running dev server reload it.
export async function writeGlossaryPage(): Promise<void> {
  const page = glossaryPage(await readFile(glossarySource, 'utf8'));
  const current = await readFile(glossaryPagePath, 'utf8').catch(() => undefined);
  if (page !== current) {
    await writeFile(glossaryPagePath, page);
  }
}
