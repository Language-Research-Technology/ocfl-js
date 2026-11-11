import type { OcflObjectInventory } from './inventory.ts';
import type { User } from './ocfl-object.ts';
import { isAsyncIterable, OcflObjectTransaction, type UpdateTarget } from './transaction.ts';
import { isNonEmptyString } from './utils.ts';

/** What a new version records about why and by whom it was made. */
interface VersionDetails {
  /** Why the version is being made. */
  readonly message: string;
  /** Who is making it. */
  readonly user: User;
}

/** Content for {@link Draft.write}: text (stored as UTF-8), bytes, or a stream of either, such as a Node or web stream. */
type WriteContent = string | Uint8Array | AsyncIterable<string | Uint8Array>;

/**
 * The changes being assembled during an update, which become one new version or are discarded.
 *
 * It starts with the files of the head version (none, for a new object). Operations take effect in call order,
 * even when started together. Every logical path is normalised first (`./raw//1.wav` is `raw/1.wav`).
 * Using a draft after its update has finished throws an `Error`.
 */
interface Draft {
  /**
   * Puts one file at `path`, replacing a file already there.
   *
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   * @throws {@link OcflError} `FILE_EXISTS` if `path` is a directory, or lies below a file.
   * @throws `TypeError` if `content` is not a {@link WriteContent}.
   */
  write(path: string, content: WriteContent): Promise<void>;

  /**
   * Copies a file or directory from disk into the draft, at `target` or at the top. Files already there are replaced; the rest stay.
   *
   * Without a `target`, a directory's contents go at the top and a file keeps its own name there.
   * Everything below a directory is copied, including hidden files. If a file fails, the first failure is thrown and the draft is left as it was.
   *
   * @throws {@link OcflError} `UNSUPPORTED_FILE_TYPE` if `source` is, or contains, anything but regular files and directories, such as a symlink.
   * @throws {@link OcflError} `SOURCE_CHANGED` if a file changed while it was being read.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `target` is empty or leaves the object.
   * @throws {@link OcflError} `FILE_EXISTS` if a path would become both a file and a directory.
   */
  import(source: string, target?: string): Promise<void>;

  /**
   * Removes a file, or every file below a directory, from the draft. Earlier versions keep it.
   *
   * @throws {@link OcflError} `FILE_NOT_FOUND` if `path` is not in the draft.
   * @throws {@link OcflError} `INVALID_LOGICAL_PATH` if `path` is empty or leaves the object.
   */
  remove(path: string): Promise<void>;

  /** Removes every file from the draft. */
  clear(): Promise<void>;
}

/**
 * @returns A copy of `details` holding only what a version records
 * @throws `TypeError` if the message or the user's name is missing or empty, or the user's address isn't a string
 */
function checkedDetails(details: VersionDetails): VersionDetails {
  const { message, user } = details ?? {};
  if (!isNonEmptyString(message)) {
    throw new TypeError('The message of the version is required.');
  }
  if (!isNonEmptyString(user?.name)) {
    throw new TypeError('The name of the user making the version is required.');
  }
  if (user.address !== undefined && typeof user.address !== 'string') {
    throw new TypeError('The address of the user making the version must be a string.');
  }
  return { message, user: { name: user.name, ...(user.address !== undefined && { address: user.address }) } };
}

/** @throws `TypeError` if `content` is not a {@link WriteContent}. What a stream yields is checked as it is read. */
function checkContent(content: unknown): void {
  if (typeof content !== 'string' && !(content instanceof Uint8Array) && !isAsyncIterable(content)) {
    throw new TypeError(`Unsupported data type: ${Object.prototype.toString.call(content)}`);
  }
}

class ObjectDraft implements Draft {
  readonly #transaction: OcflObjectTransaction;
  #finished = false;

  constructor(transaction: OcflObjectTransaction) {
    this.#transaction = transaction;
  }

  get #open(): OcflObjectTransaction {
    if (this.#finished) {
      throw new Error('The update this draft belongs to has finished.');
    }
    return this.#transaction;
  }

  /** @internal */
  _finish(): void {
    this.#finished = true;
  }

  async write(path: string, content: WriteContent): Promise<void> {
    checkContent(content);
    return this.#open.write(path, content);
  }

  async import(source: string, target?: string): Promise<void> {
    return this.#open.import(source, target);
  }

  async remove(path: string): Promise<void> {
    return this.#open.remove(path);
  }

  async clear(): Promise<void> {
    return this.#open.clear();
  }
}

/**
 * Runs `change` on a draft of the version `inventory` is at, then commits it, or discards it if `change` throws.
 * @param inventory - Already at its new version
 * @returns The committed inventory, or `undefined` if the draft ended the same as the previous version
 */
async function commitDraft(
  target: UpdateTarget,
  inventory: OcflObjectInventory,
  details: VersionDetails,
  change: (draft: Draft) => Promise<void>,
): Promise<OcflObjectInventory | undefined> {
  const transaction = await OcflObjectTransaction.create(target, inventory);
  const draft = new ObjectDraft(transaction);
  try {
    await change(draft);
  } catch (error) {
    draft._finish();
    // A failure to discard the draft must not replace the callback's error
    await transaction.rollback().catch(() => {});
    throw error;
  }
  draft._finish();
  return transaction._commit(details);
}

export { checkedDetails, commitDraft, type Draft, type VersionDetails, type WriteContent };
