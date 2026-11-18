import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import packageJson from '../package.json' with { type: 'json' };
import { glossarySource, writeGlossaryPage } from './glossary.ts';
import { editBaseUrl, repoUrl } from './repo.ts';

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
      description: packageJson.description,
      social: [{ icon: 'github', label: 'GitHub', href: repoUrl }],
      editLink: { baseUrl: `${editBaseUrl}website/` },
      components: { SiteTitle: './src/components/SiteTitle.astro' },
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
