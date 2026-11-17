import assert from 'node:assert';
import { describe, it } from 'node:test';
import { glossaryPage } from '../website/glossary.ts';

const glossary = `# OCFL for JavaScript

Terms used by this library.

## Language

**Logical path**:
The path of a file in a version, such as \`notes/field-notes.txt\`.
_Avoid_: Filename, key
`;

describe('glossaryPage', () => {
  const page = glossaryPage(glossary);

  it('makes each term a heading under its section, so pages can link to it', () => {
    assert.match(page, /^### Logical path\n\nThe path of a file in a version, such as `notes\/field-notes.txt`\.$/m);
  });

  it('replaces the first heading with frontmatter and keeps the rest', () => {
    assert.match(page, /^---\ntitle: Glossary\ndescription: [^\n]+\n---\n/);
    assert.doesNotMatch(page, /^# /m);
    assert.match(page, /\n\nTerms used by this library\.\n\n## Language\n/);
  });

  it('says where to edit it', () => {
    assert.match(page, /<!-- Generated from GLOSSARY\.md[^>]*-->/);
  });

  it('puts the words to avoid in a paragraph of their own', () => {
    assert.match(page, /`\.\n\n_Avoid_: Filename, key\n/);
  });

  it('gives the same page for Windows line endings', () => {
    assert.strictEqual(glossaryPage(glossary.replaceAll('\n', '\r\n')), page);
  });

  it('refuses a glossary that does not start with its heading, rather than make a page with no title', () => {
    assert.throws(() => glossaryPage(`\n${glossary}`), /GLOSSARY\.md must start with a `# ` heading/);
  });
});
