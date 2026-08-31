// Generate a Kiwi codec for Figma's schema and cache it by schema hash.
// Requires a one-time clone of evanw/kiwi + npx tsx (cached afterwards).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { extractCompressedSchema, isFigWireFrame, isZstd } from './wire.mjs';

const require = createRequire(import.meta.url);
const CACHE = process.env.FIGMA_KIWI_CACHE || `${process.env.HOME}/.cache/figma-kiwi`;

function ensureKiwiCli(dir) {
  const repo = `${dir}/_kiwi`;
  if (!existsSync(`${repo}/js/cli.ts`)) {
    mkdirSync(dir, { recursive: true });
    execSync(`git clone --depth 1 https://github.com/evanw/kiwi.git ${repo}`, { stdio: 'inherit' });
  }
  return repo;
}

function loadFzstd() {
  return require(require.resolve('fzstd', { paths: [CACHE, process.cwd()] }));
}

export function schemaHash(schemaBin) {
  return createHash('sha1').update(schemaBin).digest('hex').slice(0, 12);
}

export async function getDecoder(schemaBin) {
  const hash = schemaHash(schemaBin);
  const out = `${CACHE}/decoder-${hash}.js`;
  if (existsSync(out)) return require(out);
  const repo = ensureKiwiCli(CACHE);
  if (!existsSync(`${CACHE}/node_modules/fzstd`)) {
    execSync(`npm install fzstd kiwi-schema --prefix ${CACHE} --silent`, { stdio: 'inherit' });
  }
  // The fig-wire payload is zstd-compressed; the kiwi CLI wants raw schema bytes.
  const raw = isZstd(schemaBin) ? new Uint8Array(loadFzstd().decompress(schemaBin)) : schemaBin;
  const schemaPath = `${CACHE}/schema-${hash}.bin`;
  writeFileSync(schemaPath, raw);
  execSync(`npx tsx cli.ts --schema ${schemaPath} --js ${out}`, {
    cwd: `${repo}/js`, stdio: 'inherit', timeout: 60000,
  });
  return require(out);
}

export function decoderFromSchemaFrame(figWireFrame) {
  const buf = Buffer.from(figWireFrame);
  if (!isFigWireFrame(new Uint8Array(buf))) throw new Error('Not a fig-wire frame');
  return getDecoder(new Uint8Array(extractCompressedSchema(new Uint8Array(buf))));
}

export { writeFileSync };
