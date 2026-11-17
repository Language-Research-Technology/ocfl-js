import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import { glossarySource, writeGlossaryPage } from './glossary.ts';

export default defineConfig({
  site: 'https://language-research-technology.github.io',
  base: '/ocfl-js',
  integrations: [
    {
      name: 'glossary',
      hooks: {
        'astro:config:setup': async ({ addWatchFile }) => {
          addWatchFile(glossarySource);
          await writeGlossaryPage();
        },
      },
    },
    starlight({
      title: 'ocfl-fs',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/Language-Research-Technology/ocfl-js' }],
      plugins: [
        starlightLinksValidator(),
        starlightTypeDoc({
          entryPoints: ['../src/index.ts'],
          tsconfig: '../tsconfig.json',
          typeDoc: { excludeInternal: true },
        }),
      ],
      sidebar: ['concepts', { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] }, 'glossary', typeDocSidebarGroup],
    }),
  ],
});
