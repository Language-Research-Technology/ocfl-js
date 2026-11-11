import fs from 'node:fs';
import path from 'node:path';

/** Writes a tree `depth` levels deep under `dir`: `width` directories at each level, and `width` files in each of the deepest */
export async function makeTree(dir: string, depth: number, width: number): Promise<void> {
  for (let i = 0; i < width; i++) {
    if (depth === 1) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, `f${i}.txt`), `${dir}/f${i}`);
    } else {
      await makeTree(path.join(dir, `d${i}`), depth - 1, width);
    }
  }
}
