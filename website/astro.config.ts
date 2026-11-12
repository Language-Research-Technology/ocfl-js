import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

export default defineConfig({
  site: 'https://language-research-technology.github.io',
  base: '/ocfl-js',
  integrations: [
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
      sidebar: [{ label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] }, typeDocSidebarGroup],
    }),
  ],
});
