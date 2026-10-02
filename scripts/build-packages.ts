/**
 * Build the two publishable packages: `agentegram` (the SDK) and `agentegram-mcp`.
 *
 *   npx tsx scripts/build-packages.ts
 *
 * The repo imports its own packages through tsconfig path aliases (`@agentline/crypto`) and
 * writes imports with `.ts` extensions, neither of which survives outside this checkout. So
 * the SDK is bundled with esbuild — crypto and protocol inlined, real npm dependencies left
 * external — and its types are emitted separately and rolled into one `.d.ts`.
 *
 * Publishing a package does NOT publish this repository: only the files listed in each
 * package.json `files` array are uploaded, which is `dist` and a README.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SDK = join(ROOT, 'packages/sdk');
const MCP = join(ROOT, 'packages/mcp');

/** Runtime dependencies stay external: a bundled copy of viem would be absurd. */
const EXTERNAL = [
  '@noble/*', '@scure/*', '@x402/*', '@algorandfoundation/*',
  'algosdk', 'cbor-x', 'viem', 'viem/*', '@modelcontextprotocol/*', 'node:*',
];

async function bundleSdk(): Promise<void> {
  rmSync(join(SDK, 'dist'), { recursive: true, force: true });
  await build({
    entryPoints: [join(SDK, 'src/index.ts')],
    outfile: join(SDK, 'dist/index.js'),
    bundle: true, format: 'esm', platform: 'neutral', target: 'node20',
    external: EXTERNAL,
    // The path aliases only exist in tsconfig, so esbuild needs them spelled out.
    alias: {
      '@agentline/crypto': join(ROOT, 'packages/crypto/src/index.ts'),
      '@agentline/protocol': join(ROOT, 'packages/protocol/src/index.ts'),
    },
    sourcemap: true,
    logLevel: 'warning',
  });
  console.log('  bundled  packages/sdk/dist/index.js');
}

/**
 * Types for the SDK.
 *
 * `tsc --emitDeclarationOnly` is the only emit mode allowed alongside
 * `allowImportingTsExtensions`, and `rewriteRelativeImportExtensions` turns the `.ts`
 * specifiers in the output into `.js` so the published types resolve.
 */
function emitTypes(): void {
  const tsconfig = join(ROOT, 'tsconfig.build.json');
  writeFileSync(tsconfig, JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: {
      noEmit: false,
      emitDeclarationOnly: true,
      declaration: true,
      rewriteRelativeImportExtensions: true,
      outDir: 'packages/sdk/dist/types',
      rootDir: 'packages',
    },
    include: ['packages/sdk/src/**/*.ts', 'packages/crypto/src/**/*.ts', 'packages/protocol/src/**/*.ts'],
  }, null, 2));
  try {
    execFileSync('npx', ['tsc', '-p', tsconfig], { cwd: ROOT, stdio: 'inherit' });
  } finally {
    rmSync(tsconfig, { force: true });
  }

  // The bundle inlines crypto and protocol, so the entry type must point at the emitted
  // declarations rather than at the aliases, which do not exist for a consumer.
  const entry = join(SDK, 'dist/types/sdk/src/index.d.ts');
  let dts = readFileSync(entry, 'utf8');
  dts = dts
    .replace(/from '@agentline\/crypto'/g, "from '../../crypto/src/index.js'")
    .replace(/from '@agentline\/protocol'/g, "from '../../protocol/src/index.js'");
  writeFileSync(entry, dts);
  writeFileSync(join(SDK, 'dist/index.d.ts'), "export * from './types/sdk/src/index.js';\n");
  console.log('  typed    packages/sdk/dist/index.d.ts');
}

async function bundleMcp(): Promise<void> {
  rmSync(join(MCP, 'dist'), { recursive: true, force: true });
  await build({
    entryPoints: [join(MCP, 'src/index.ts')],
    outfile: join(MCP, 'dist/cli.js'),
    bundle: true, format: 'esm', platform: 'node', target: 'node20',
    // The SDK is a real dependency of the published package, not something to inline twice.
    external: [...EXTERNAL, 'agentegram'],
    alias: { '@agentline/sdk': 'agentegram' },
    // No banner: the entry already carries a shebang and esbuild keeps it, so adding one
    // here produces two — and the second is a syntax error, not a comment.
    sourcemap: true,
    logLevel: 'warning',
  });
  console.log('  bundled  packages/mcp/dist/cli.js');
}

function copyReadmes(): void {
  for (const [pkg, name] of [[SDK, 'SDK'], [MCP, 'MCP']] as const) {
    const readme = join(pkg, 'README.md');
    try {
      readFileSync(readme);
    } catch {
      throw new Error(`${name} package is missing its README.md — it is the npm listing page`);
    }
  }
  mkdirSync(join(SDK, 'dist'), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(SDK, 'LICENSE'), { force: true });
  cpSync(join(ROOT, 'LICENSE'), join(MCP, 'LICENSE'), { force: true });
}

console.log('building publishable packages');
await bundleSdk();
emitTypes();
await bundleMcp();
copyReadmes();
console.log('\nready. Inspect exactly what would be uploaded:');
console.log('  npm pack --dry-run ./packages/sdk');
console.log('  npm pack --dry-run ./packages/mcp');
console.log('\nthen, once logged in (npm login):');
console.log('  npm publish ./packages/sdk --access public');
console.log('  npm publish ./packages/mcp --access public');
