// Standalone smoke test for the polyhaven service.
// Run: node --import tsx/esm probe-polyhaven.mjs
import 'dotenv/config';
import { resolveMaterial, allowedMaterialTypes } from './src/polyhaven.ts';

async function main() {
  console.log('Allowed materialTypes:', allowedMaterialTypes().join(', '));

  const t0 = Date.now();
  const r1 = await resolveMaterial('grass');
  console.log(`\nfirst resolve grass took ${Date.now() - t0}ms:`);
  console.log(r1 ?? '(null — POLYHAVEN_SKIP=1 or slug missing)');

  const t1 = Date.now();
  const r2 = await resolveMaterial('grass');
  console.log(`\nsecond resolve grass took ${Date.now() - t1}ms (expected fast cache-hit):`);
  console.log(r2 ?? '(null)');
}

main().catch(e => { console.error(e); process.exit(1); });
