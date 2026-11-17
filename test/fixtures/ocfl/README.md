# OCFL fixtures

The files under `1.1/` are copied unmodified from the [OCFL fixtures](https://github.com/OCFL/fixtures)
repository at commit [`d323fc2`](https://github.com/OCFL/fixtures/tree/d323fc207126becec066998b43408d998bf0fb1b).

`test/official-fixtures.spec.ts` reads every good object and checks that each bad object is refused with one of
the codes in its name. Other specs use `spec-ex-full` and the `content/` directories.

- `1.1/good-objects/`: every OCFL 1.1 good object:
  - `diff_files_same_md5`
  - `minimal_content_dir_called_stuff`
  - `minimal_logs_directory_one_log_file`
  - `minimal_mixed_digests`
  - `minimal_no_content`
  - `minimal_one_version_one_file`
  - `minimal_uppercase_digests`
  - `ocfl_object_all_fixity_digests`
  - `spec-ex-full`
  - `spec-ex-minimal`
  - `updates_all_actions`
  - `updates_three_versions_one_file`
- `1.1/bad-objects/`: the OCFL 1.1 bad objects for codes the library raises:
  - `E007_bad_declaration_contents`
  - `E008_E036_no_versions_no_head`
  - `E010_skipped_versions`
  - `E011_E013_invalid_padded_head_version`
  - `E017_invalid_content_dir`
  - `E036_no_head`
  - `E036_no_id`
  - `E040_head_not_most_recent`
  - `E040_wrong_head_doesnt_exist`
  - `E040_wrong_head_format`
  - `E049_E050_E054_bad_version_block_values`
  - `E050_state_digest_not_in_manifest`
  - `E053_E052_invalid_logical_paths`
  - `E060_E064_root_inventory_digest_mismatch`
  - `E095_conflicting_logical_paths`
  - `E095_non_unique_logical_paths`
  - `E096_manifest_duplicate_digests`
  - `E100_E099_manifest_invalid_content_paths`
- `1.1/content/spec-ex-full/v3` and `1.1/content/spec-ex-diff-paths/v1`.

These bad objects name a code the library raises but are left out, because the library opens them:

- `E010_missing_versions`: the fault is a version directory missing from disk, and opening reads only the root
  inventory.
- `E040_wrong_version_in_version_dir` and `E060_version_inventory_digest_mismatch`: the fault is in a version
  inventory, and the library reads only the root inventory.
- `E050_manifest_digest_wrong_case`: the library compares digests without regard to case, as the spec's
  implementation note on digests advises, so the state's upper-case digest matches the manifest's.
- `E058_no_sidecar`: a root inventory with no sidecar that matches its head version's inventory is what a commit
  leaves between replacing the inventory and its sidecar, so the library accepts it (ADR 0005).
- `E100_E099_fixity_invalid_content_paths`: the fault is in the `fixity` block, which the library doesn't read.

These are left out because they have no object declaration, so listing doesn't count them as objects:

- `E003_no_decl`: opening it is refused with `E003`.
- `E003_E063_empty`: an empty directory, which is no object at all.

"Oxford Common File Layout - Fixtures" by the OCFL editors and community is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Keep the files byte-for-byte identical to upstream: each inventory's `.sha512` sidecar holds the digest of its exact bytes.
