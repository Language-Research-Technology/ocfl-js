/** The version the site's header shows: the release tag it was built from, or `main` for any other build. */
export function siteVersion(tag: string | undefined): string {
  return tag || 'main';
}
