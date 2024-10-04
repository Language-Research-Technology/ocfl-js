const fs = require('node:fs/promises');
const path = require('node:path');

/** 
 * Wrapper for fs.opendir that reimplements the recursion and 
 * returns just the file without the directory itself
 * fs.opendir has a bug that gives wrong result when recursive option is used
 * @param {string} dirPath
 * @param {OpenDirOptions} [options]
 */
async function* opendir(dirPath, { encoding = 'utf8', bufferSize = 32, recursive = false } = {}) {
  /** @type Promise<{ name: string, path: string, size: number, lastModified: Date}>[] */
  let buffer = [];
  let dirp;
  const maxBuffer = bufferSize || 1;
  const dirQueue = [fs.opendir(dirPath, { encoding, bufferSize })];
  while (dirp = dirQueue.shift()) {
    const dir = await dirp;
    for await (const de of dir) {
      const cdp = path.join(dir.path, de.name);
      if (recursive && de.isDirectory()) {
        dirQueue.push(fs.opendir(cdp));
      } else {
        let f = fs.stat(cdp).then(stats => ({
          name: de.name,
          path: path.relative(dirPath, cdp),
          size: stats.size,
          lastModified: stats.mtime
        }));
        if (buffer.length < maxBuffer) {
          buffer.push(f);
        } else {
          yield buffer.shift();
          buffer.push(f);
        }
      }
    }
  }
  let file;
  while (file = buffer.shift()) {
    yield file;
  }
}

// (async function() {
  // var a = opendir('/home/alvinsw/.ssh', {recursive: true})
  // var b = 'a';
  // console.log(await a);

  // let c = 0;
  // for await (const f of await opendir('/home/alvinsw/uqlang', {recursive: true})) {
  //   c++;
  // }
  // console.log(c);
  // c=0;
  // for await (const f of await fs.opendir('/home/alvinsw/uqlang', {recursive: true})) {
  //   c++;
  // }
  // console.log(c);
// })();

module.exports = { opendir }