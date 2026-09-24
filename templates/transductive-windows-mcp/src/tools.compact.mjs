// GENERATED COMPACT TOOL CONTRACT LOADER. DO NOT HAND EDIT.
import c0 from './tools-data/chunk-00.mjs';
import c1 from './tools-data/chunk-01.mjs';
import c2 from './tools-data/chunk-02.mjs';
import c3 from './tools-data/chunk-03.mjs';
import c4 from './tools-data/chunk-04.mjs';
import c5 from './tools-data/chunk-05.mjs';
const TOOLS_GZIP_BASE64 = [c0, c1, c2, c3, c4, c5].join('');
let cache = null;

export async function getToolSurface() {
  if (!cache) cache = inflate();
  return cache;
}

async function inflate() {
  const binary = atob(TOOLS_GZIP_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const surface = JSON.parse(text);
  if (surface?.schema !== 'TRANSDUCTIVE_WINRDP_TOOL_SURFACE/1' || surface?.count !== 144 || !Array.isArray(surface?.tools)) {
    throw new Error('TOOL_SURFACE_INTEGRITY_FAILURE');
  }
  return surface;
}
