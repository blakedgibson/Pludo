// Thin wrapper around Meshy.ai's text-to-3D REST API.
// https://docs.meshy.ai/api/text-to-3d
//
// Set MESHY_DEV_MODE=true in .env to skip all real Meshy API calls.
// Every asset returns an empty URL so Unity's colored-cube fallback is used.
// Use this during Lua script / template / UI development to avoid burning credits.
//
// Credit costs (confirmed from consumed_credits field in API responses):
//   preview:  5 credits
//   refine:  10 credits  (2× preview — dominant cost)
//   rig:     unknown (v1 listing endpoint not available; estimated ~5–10)
//
// Set MESHY_SKIP_REFINE=true to skip refine for all props.
// Cost per asset drops from 15 → 5 credits; per game from 90 → 30.

const MESHY_V2 = 'https://api.meshy.ai/openapi/v2';
const MESHY_V1 = 'https://api.meshy.ai/openapi/v1';

export function meshyDevMode(): boolean {
  return process.env.MESHY_DEV_MODE === 'true';
}

export function meshySkipRefine(): boolean {
  return process.env.MESHY_SKIP_REFINE === 'true';
}

export type MeshyStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export interface MeshyTask {
  id: string;
  status: MeshyStatus;
  progress: number;
  thumbnail_url?: string;
  model_urls?: { glb?: string; fbx?: string; obj?: string };
  task_error?: { message?: string };
  consumed_credits?: number;  // present on final SUCCEEDED/FAILED poll
}

function key(): string {
  const k = process.env.MESHY_API_KEY;
  if (!k) throw new Error('MESHY_API_KEY not configured');
  return k;
}

async function meshyFetch<T>(base: string, path: string, init: RequestInit = {}, maxRetries = 3): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(5_000 * Math.pow(2, attempt - 1), 30_000); // 5s, 10s, 20s
      console.warn(`[meshy] retry ${attempt}/${maxRetries - 1} for ${path} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${key()}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (networkErr) {
      lastErr = networkErr instanceof Error ? networkErr : new Error(String(networkErr));
      console.warn(`[meshy] network error on ${path}:`, lastErr.message);
      continue; // retry on network failures
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Meshy ${res.status}: ${text.slice(0, 200)}`);
      // Retry only on rate-limit (429) and server errors (5xx); hard-fail on 4xx
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        console.warn(`[meshy] transient error ${res.status} on ${path} — will retry`);
        continue;
      }
      throw err;
    }
    return res.json() as Promise<T>;
  }
  throw lastErr!;
}

// ── Text-to-3D (v2) ─────────────────────────────────────────────────────────

// prompt must be ≤ 600 characters — enforced by the caller (claude output).
// Meshy v2 currently accepts only art_style: 'realistic' (other values return
// 400 "Invalid values: ArtStyle must be one of [realistic]"). The chibi/stylized
// look is enforced via the prompt suffix in resolveAsset, not this flag.
export async function createPreview(prompt: string): Promise<string> {
  const data = await meshyFetch<{ result: string }>(MESHY_V2, '/text-to-3d', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'preview',
      prompt: prompt.slice(0, 600),
      art_style: 'realistic',
      ai_model: 'meshy-5',
      // quad topology produces cleaner meshes for rigging
      topology: 'quad',
      should_remesh: true,
    }),
  });
  return data.result;
}

export async function createRefine(previewTaskId: string): Promise<string> {
  const data = await meshyFetch<{ result: string }>(MESHY_V2, '/text-to-3d', {
    method: 'POST',
    body: JSON.stringify({ mode: 'refine', preview_task_id: previewTaskId, enable_pbr: true }),
  });
  return data.result;
}

export async function getTask(taskId: string): Promise<MeshyTask> {
  return meshyFetch<MeshyTask>(MESHY_V2, `/text-to-3d/${taskId}`);
}

export async function waitForTask(taskId: string, timeoutMs = 180_000): Promise<MeshyTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await getTask(taskId);
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED' || task.status === 'CANCELED')
      throw new Error(`Meshy task ${taskId} ${task.status}: ${task.task_error?.message ?? ''}`);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`Meshy task ${taskId} timed out after ${timeoutMs / 1000}s`);
}

// ── Humanoid Rig (v1) ────────────────────────────────────────────────────────
// Automatically rigs a completed text-to-3D model with a humanoid skeleton.
// The rigged GLB can be loaded in Unity with a HumanoidAvatar for animation.

export async function createRig(previewTaskId: string): Promise<string> {
  const data = await meshyFetch<{ result: string }>(MESHY_V1, '/text-3d-rig/tasks', {
    method: 'POST',
    body: JSON.stringify({ preview_task_id: previewTaskId }),
  });
  return data.result;
}

export async function getRigTask(rigTaskId: string): Promise<MeshyTask> {
  return meshyFetch<MeshyTask>(MESHY_V1, `/text-3d-rig/tasks/${rigTaskId}`);
}

export async function waitForRig(rigTaskId: string, timeoutMs = 240_000): Promise<MeshyTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await getRigTask(rigTaskId);
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED' || task.status === 'CANCELED')
      throw new Error(`Meshy rig ${rigTaskId} ${task.status}: ${task.task_error?.message ?? ''}`);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`Meshy rig ${rigTaskId} timed out after ${timeoutMs / 1000}s`);
}

// ── Credit balance ────────────────────────────────────────────────────────────

export async function getBalance(): Promise<number> {
  if (meshyDevMode()) return -1; // sentinel: dev mode, no real balance
  try {
    const data = await meshyFetch<{ balance: number }>(MESHY_V1, '/balance');
    return data.balance;
  } catch {
    return -1; // -1 means "unknown" — don't block generation on balance check failure
  }
}
