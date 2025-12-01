/**
 * @typedef {Object} FileRef
 * @property {string} [contentPath] - Actual path to the file location relative to the ocfl object root.
 * @property {string} [logicalPath] - A path that represents a file’s location in the logical state of an object.
 * @property {string} [digest] - An algorithmic characterization of the contents of a file conforming to a standard digest algorithm.
 * @property {string} [version] - Version of the OCFL object.
 * @property {string} [lastModified] - Last modified date of the file.
 * @property {string} [size] - Size of the file in bytes.
 * @property {Object.<string, string>} [fixity] - Fixity information of the file.
 */

/**
 * Represent a file in an OCFL object
 */
class OcflObjectFile {
  #ocflObject;
  #lastModified;
  #size;

  /**
   * 
   * @param {import('./object').OcflObject} ocflObject 
   * @param {FileRef} fileRef 
   */
  constructor(ocflObject, fileRef) {
    this.#ocflObject = ocflObject;
    // for (const key in ['logicalPath', 'version', 'digest', 'contentPath']) {
    //   if (fileRef[key]) this[key] = fileRef[key];
    // }
    if (fileRef.logicalPath) this.logicalPath = fileRef.logicalPath;
    if (fileRef.contentPath) this.contentPath = fileRef.contentPath;
    if (fileRef.digest) this.digest = fileRef.digest;
    if (fileRef.version) this.version = fileRef.version;
    if (fileRef.lastModified != null) this.#lastModified = fileRef.lastModified;
    if (fileRef.size != null) this.#size = fileRef.size;
    if (fileRef.fixity != null) this.fixity = fileRef.fixity;
  }

  /**
   * Resolve contentPath given either the `logicalPath` and `version`, `digest`, or `contentPath`.
   */
  async #resolveContentPath() {
    let contentPath = this.contentPath;
    if (!contentPath) {
      let inv = await this.#ocflObject.getInventory();
      if (!inv) throw new Error(`OCFL Object "${this.#ocflObject.id}" does not exist`);
      let version = !this.version || this.version === 'latest' ? inv.head : this.version;
      let digest = this.digest || inv.getDigest(this.logicalPath, version);
      contentPath = inv.getContentPath(digest);
      if (!contentPath) throw new Error(`Cannot find content "${this.toString()}" in the OCFL Object "${this.#ocflObject.id}" version "${this.version || 'latest'}"`);
    }
    return contentPath;
  }

  /**
   * Returns the last modified time of the file, in millisecond since the UNIX epoch (January 1st, 1970 at Midnight).
   */
  get lastModified() { return this.#lastModified }

  /**
   * Returns the file size in bytes.
   */
  get size() { return this.#size }

  toString() {
    let props = [];
    for (const key in ['logicalPath', 'version', 'digest', 'contentPath']) {
      if (this[key]) props.push(key + ": '" + this[key] + "'");
    }
    return `{ ${props.join(', ')} }`;
  }

  /**
   * Get the file content as a buffer
   * @param {*} [options] Options to be passed to underlying data store specific implementation

   * @return {Promise<Buffer>}
   */
  async buffer(options) {
    return this.#ocflObject.readFile(await this.#resolveContentPath(), options);
  }

  /**
   * @deprecated Use {@link buffer()}
   */
  async asBuffer(options) {
    return this.buffer(options);
  }

  /**
   * Get the file content as a string
   * @param {BufferEncoding} [encoding='utf8'] String encoding, default to utf8
   * @return {Promise<string>}
   */
  async text(encoding = 'utf8') {
    // @ts-ignore
    return this.buffer(encoding);
  }
  /**
   * @deprecated Use {@link text()}
   */
  async asString(encoding = 'utf8') {
    // @ts-ignore
    return this.text(encoding);
  }

  /**
   * Get the file content as a NodeJS stream
   * @param {*} [options] Options to be passed to underlying data store specific implementation
   * @return {Promise<ReadableStream>}
   * @deprecated Use {@link stream()}
   */
  async asStream(options) {
    return this.#ocflObject.createReadable(await this.#resolveContentPath(), options);
  }

  /**
   * Get the file content as a ES Streams standard ReadableStream
   * @param {*} [options] Options to be passed to underlying data store specific implementation
   * @return {Promise<ReadableStream>}
   */
  async stream(options) {
    return this.#ocflObject.createReadable(await this.#resolveContentPath(), options);
  }
}

module.exports = {
  OcflObjectFile
};