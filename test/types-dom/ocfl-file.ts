import { Readable } from 'node:stream';
import type { OcflFile } from '../../src/index.ts';

export async function bytesGoStraightIntoWebApis(file: OcflFile): Promise<Response[]> {
  const bytes = await file.bytes();
  return [new Response(bytes), new Response(new Blob([bytes]))];
}

export async function streamChunksAreCopiedIntoWebApis(file: OcflFile): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for await (const chunk of (await file.stream()) as AsyncIterable<Buffer>) {
    // @ts-expect-error a Buffer's ArrayBufferLike isn't a BlobPart
    blobs.push(new Blob([chunk]));
    blobs.push(new Blob([new Uint8Array(chunk)]));
  }
  return blobs;
}

export async function streamGoesIntoAResponseAsTheDomStream(file: OcflFile): Promise<Response[]> {
  // @ts-expect-error @types/node's web ReadableStream isn't the DOM's
  const uncast = new Response(Readable.toWeb(await file.stream()));
  return [uncast, new Response(Readable.toWeb(await file.stream()) as ReadableStream)];
}
