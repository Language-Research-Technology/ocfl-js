import type { OcflFile } from '../../src/index.ts';

export async function bytesGoStraightIntoWebApis(file: OcflFile): Promise<Response[]> {
  const bytes = await file.bytes();
  return [new Response(bytes), new Response(new Blob([bytes]))];
}
