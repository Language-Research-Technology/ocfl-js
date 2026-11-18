import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { isOcflError, type OcflObject, openStorageRoot } from '@ocfl/ocfl-fs';

const root = await openStorageRoot('/srv/ocfl');
const opened = new Map<string, OcflObject>();

/** The object as it is now: the one opened before while no version has been committed since, or else opened again */
async function current(id: string): Promise<OcflObject> {
  let object = opened.get(id);
  if (!object || !(await object.isCurrent())) {
    object = await root.open(id);
    opened.set(id, object);
  }
  return object;
}

/** Reads `bytes=start-end` or `bytes=start-`; a suffix range such as `bytes=-500` isn't handled here. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!match?.[1]) {
    return undefined;
  }
  return { start: Number(match[1]), end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

// GET /?id=arcp://name,corpus/item/1&path=audio/1.wav
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const id = url.searchParams.get('id');
  const path = url.searchParams.get('path');
  if (!id || !path) {
    response.writeHead(400).end();
    return;
  }
  try {
    const object = await current(id);
    const file = object.head.files.get(path);
    if (!file) {
      response.writeHead(404).end();
      return;
    }

    const size = await file.size();
    const range = parseRange(request.headers.range, size);
    // Rejects before any headers are sent
    const body = await file.stream(range);
    response.writeHead(range ? 206 : 200, {
      etag: `"${file.digest}"`,
      'last-modified': file.modifiedAt.toUTCString(),
      'content-length': range ? range.end - range.start + 1 : size,
      ...(range && { 'content-range': `bytes ${range.start}-${range.end}/${size}` }),
    });
    await pipeline(body, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
    } else if (error instanceof RangeError) {
      response.writeHead(416).end();
    } else if (isOcflError(error, 'OBJECT_NOT_FOUND')) {
      response.writeHead(404).end();
    } else {
      console.error(error);
      response.writeHead(500).end();
    }
  }
});

server.listen(8080);
