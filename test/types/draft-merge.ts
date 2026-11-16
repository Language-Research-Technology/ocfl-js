import type { Draft, MergeOptions } from '../../src/index.ts';

export async function copyAndRenameTakeAMergeOption(draft: Draft): Promise<void> {
  await draft.copy('a', 'b', { merge: true });
  await draft.copy('a', 'b', { merge: false });
  await draft.rename('a', 'b', { merge: true });
  await draft.rename('a', 'b', { merge: false });
  await draft.copy('a', 'b', undefined);
  await draft.rename('a', 'b', undefined);
  await draft.copy('a', 'b', {});
  await draft.rename('a', 'b', {});

  const forwarded: { merge?: boolean | undefined } = {};
  await draft.copy('a', 'b', { merge: forwarded.merge });
  await draft.rename('a', 'b', { merge: forwarded.merge });

  const options: MergeOptions = Math.random() < 0.5 ? { merge: true } : {};
  const copied: Promise<void> = draft.copy('a', 'b', options);
  const renamed: Promise<void> = draft.rename('a', 'b', options);
  await Promise.all([copied, renamed]);

  // @ts-expect-error merge is the only option
  await draft.copy('a', 'b', { merge: true, overwrite: true });
  // @ts-expect-error merge is the only option
  await draft.rename('a', 'b', { merge: true, overwrite: true });
  // @ts-expect-error merge is the only option
  await draft.copy('a', 'b', { overwrite: true });
  // @ts-expect-error merge is a boolean
  await draft.copy('a', 'b', { merge: 'yes' });
  // @ts-expect-error merge is a boolean
  await draft.rename('a', 'b', { merge: 1 });
  // @ts-expect-error the options are an object, not the flag itself
  await draft.copy('a', 'b', true);
  // @ts-expect-error the options are an object, not the flag itself
  await draft.rename('a', 'b', true);

  // @ts-expect-error reinstate always merges: it takes no options
  await draft.reinstate('a', 1, { merge: true });
  // @ts-expect-error remove takes no options
  await draft.remove('a', { merge: true });
  // @ts-expect-error write takes no options
  await draft.write('a', 'text', { merge: true });
}
