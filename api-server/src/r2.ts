// Cloudflare R2 asset cache — S3-compatible via AWS SDK.
// Same prompt always produces the same cache key, so generated models are shared
// across all users and never re-generated for the same description.

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

const isProd = process.env.NODE_ENV === 'production';

const BUCKET  = isProd
  ? (process.env.R2_PROD_BUCKET  ?? 'pludo-assets')
  : (process.env.R2_DEV_BUCKET   ?? 'pludo-assets-dev');

const ACCESS_KEY_ID     = isProd ? process.env.R2_PROD_ACCESS_KEY_ID     : process.env.R2_DEV_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = isProd ? process.env.R2_PROD_SECRET_ACCESS_KEY : process.env.R2_DEV_SECRET_ACCESS_KEY;

let _s3: S3Client | null = null;

function s3(): S3Client {
  if (_s3) return _s3;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId)         throw new Error('R2_ACCOUNT_ID not configured');
  if (!ACCESS_KEY_ID)     throw new Error(`R2_${isProd ? 'PROD' : 'DEV'}_ACCESS_KEY_ID not configured`);
  if (!SECRET_ACCESS_KEY) throw new Error(`R2_${isProd ? 'PROD' : 'DEV'}_SECRET_ACCESS_KEY not configured`);
  _s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: ACCESS_KEY_ID!,
      secretAccessKey: SECRET_ACCESS_KEY!,
    },
  });
  return _s3;
}

export function r2Configured(): boolean {
  return !!(process.env.R2_ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

// Deterministic R2 key: same prompt + rig flag → same object, always.
export function assetCacheKey(prompt: string, isHumanoid: boolean): string {
  const hash = createHash('sha256')
    .update(prompt + (isHumanoid ? ':rigged' : ''))
    .digest('hex')
    .slice(0, 16);
  return `game-assets/v1/${hash}.glb`;
}

// Returns a publicly-accessible R2 CDN URL, or null if no public URL is configured.
// Never returns the private storage endpoint — Unity can't authenticate against it.
export function publicUrl(key: string): string | null {
  const base = (isProd ? process.env.R2_PROD_PUBLIC_URL : process.env.R2_DEV_PUBLIC_URL)?.replace(/\/$/, '');
  return base ? `${base}/${key}` : null;
}

export async function keyExists(key: string): Promise<boolean> {
  if (!r2Configured()) return false;
  try {
    await s3().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function uploadBuffer(
  key: string,
  data: Buffer,
  contentType = 'model/gltf-binary',
): Promise<void> {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: data,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

export interface R2Object {
  key:          string;
  size:         number;
  lastModified: Date | null;
}

// List every object under `prefix`, transparently paginated.
export async function listObjects(prefix: string): Promise<R2Object[]> {
  if (!r2Configured()) return [];
  const out: R2Object[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3().send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const o of res.Contents ?? []) {
      if (!o.Key) continue;
      out.push({
        key:          o.Key,
        size:         o.Size ?? 0,
        lastModified: o.LastModified ?? null,
      });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

// Download a GLB from R2 using authenticated S3 access.
export async function downloadBuffer(key: string): Promise<Buffer | null> {
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}
