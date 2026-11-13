import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C } from '../theme';
import { isTablet } from '../responsive';
import { AvatarItemData, AssetItem } from '../types';
import { fetchAssets } from '../api';
import { safeAreaTop, safeAreaBottom } from '../safeArea';
import { Skeleton } from '../components/Skeleton';
import { GlassButton } from '../components/GlassButton';
import { glass } from '../glass';

// Portrait canvas gets bonus width on tablet (see responsive.ts / the
// per-idiom matchWidthOrHeight blend in MobileOrientationManager.cs) — more
// columns fit without shrinking tiles. Same row-chunking approach as phone,
// just a bigger chunk size.
const SHOP_GRID_COLS = isTablet() ? 9 : 6;

type ForgePhase = 'catalog' | 'prompt' | 'forging' | 'done';

interface Props {
  onBack: () => void;
  // True when rendered inside the editor's centered overlay card, which is
  // already inset from the screen edges — the header must not add the notch
  // inset a second time.
  embedded?: boolean;
  // When provided, the picker shows the bottom Apply bar and emits the selected
  // assets. Forwards from App.tsx → CreateScreen so the editor's bottom strip
  // can list the chosen models.
  onApply?: (assets: AssetItem[]) => void;
}

function baseUrl(): string {
  try { return (Globals as any).apiBaseUrl ?? 'http://localhost:4000'; } catch { return 'http://localhost:4000'; }
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl()}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

// ── Dot spinner ───────────────────────────────────────────────────────────────

function Dots() {
  const [dot, setDot] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDot(d => (d + 1) % 4), 380);
    return () => clearInterval(t);
  }, []);
  return (
    <view style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {[0, 1, 2].map(i => (
        <icon
          key={i}
          set={i < dot ? 'material-rounded-filled' : 'material-rounded'}
          style={{ fontSize: 12, color: C.primary, lineHeight: 12 }}
        >circle</icon>
      ))}
    </view>
  );
}

// ── Asset thumbnail placeholder ──────────────────────────────────────────────
// Deterministic per-prompt color so the same model always renders with the same
// tint — gives the catalog a "different per item" feel without thumbnails.

const TILE_COLORS = [
  '#1E8CFF', '#30D158', '#FF8C00', '#BF5AF2',
  '#FF453A', '#FFD60A', '#00D4FF', '#5E5CE6',
  '#FF375F', '#64D2FF',
];

function tileColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}

// Short label for the placeholder: first ~3 distinctive letters of the prompt.
function tileGlyph(prompt: string): string {
  const m = prompt.match(/[A-Za-z]+/g) ?? [];
  if (m.length === 0) return '●';
  const first = m[0].slice(0, 1).toUpperCase();
  const second = (m[1] ?? '').slice(0, 1).toUpperCase();
  return (first + second) || '●';
}

const AssetTile = React.memo(function AssetTile({ asset, selected, onPress, size }: {
  asset: AssetItem;
  selected: boolean;
  onPress: (asset: AssetItem) => void;
  size?: number; // when omitted, tile fills its parent cell (used by the 6/row grid)
}) {
  // Square tile filled by a pre-rendered thumbnail PNG of the GLB. Falls back
  // to a hash-coloured swatch + first-letter glyph for assets whose backfill
  // hasn't run yet (no thumbnailUrl in the API response).
  const hasThumb = !!asset.thumbnailUrl;
  const dim: any = (size && size > 0) ? { width: size, height: size } : { width: '100%', height: '100%' };
  return (
    <GlassButton onClick={() => onPress(asset)} style={{
      ...dim,
      borderRadius: 0,
      backgroundColor: hasThumb ? '#1a1a1a' : tileColor(asset.cacheKey),
      borderWidth: selected ? 3 : 0,
      borderColor: selected ? C.primary : 'rgba(0,0,0,0)',
      alignItems: 'center', justifyContent: 'center',
      padding: 0,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {hasThumb ? (
        <image
          src={asset.thumbnailUrl}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, objectFit: 'cover' } as any}
        />
      ) : (
        <text style={{ fontSize: 18, color: '#fff', fontWeight: 'bold' }}>
          {tileGlyph(asset.prompt)}
        </text>
      )}
      {selected ? (
        <view style={{
          position: 'absolute', top: 4, right: 4,
          width: 20, height: 20, borderRadius: 10,
          backgroundColor: C.primary,
          alignItems: 'center', justifyContent: 'center',
          borderWidth: 2, borderColor: C.bg,
        }}>
          <icon set="material-rounded-filled" style={{ fontSize: 12, color: C.onPrimary, lineHeight: 12 }}>check</icon>
        </view>
      ) : null}
    </GlassButton>
  );
});

// ── Forge prompt screen (unchanged from previous version) ────────────────────

function ForgePromptScreen({ onBack, onForge, headerTop }: {
  onBack: () => void;
  onForge: (prompt: string) => void;
  headerTop: number;
}) {
  const [prompt, setPrompt] = useState('');

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 20, paddingTop: headerTop + 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 }}>
        <GlassButton onClick={onBack} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.text, lineHeight: 24 }}>arrow_back</icon>
        </GlassButton>
        <text style={{ fontSize: 24, color: C.text, fontWeight: 'bold', flex: 1 }}>Forge Asset</text>
      </view>

      <view style={{ flex: 1, paddingLeft: 20, paddingRight: 20, paddingTop: 24 }}>
        <view style={{ alignItems: 'center', marginBottom: 28 }}>
          <view style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.primaryTint, alignItems: 'center', justifyContent: 'center', marginBottom: 12, borderWidth: 2, borderColor: C.primary }}>
            <icon set="material-rounded" style={{ fontSize: 32, color: C.primary, lineHeight: 32 }}>auto_awesome</icon>
          </view>
          <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold', textAlign: 'center', marginBottom: 6 }}>
            Forge a new 3D asset
          </text>
          <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center', lineHeight: 18 }}>
            Describe an object and AI will generate it as a 3D model.
          </text>
        </view>

        <view style={{ position: 'relative', backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, marginBottom: 16 }}>
          <input
            value={prompt}
            onChange={(val: any) => setPrompt(val)}
            placeholder="e.g. A glowing neon samurai helmet with dragon horns..."
            style={{
              fontSize: 15, color: C.text, backgroundColor: 'transparent',
              borderWidth: 0,
              paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 72,
              minHeight: 120,
            }}
          />
          <GlassButton onClick={() => { if (prompt.trim()) onForge(prompt.trim()); }} style={{
            position: 'absolute', bottom: 12, right: 12,
            height: 44, borderRadius: 12,
            backgroundColor: prompt.trim() ? C.primary : C.surface, borderWidth: 0,
            alignItems: 'center', justifyContent: 'center',
            paddingLeft: 20, paddingRight: 20,
          }}>
            <text style={{ fontSize: 14, color: prompt.trim() ? C.onPrimary : C.secondary, fontWeight: 'bold' }}>
              Forge
            </text>
          </GlassButton>
        </view>
      </view>
    </view>
  );
}

// ── Forging progress screen ───────────────────────────────────────────────────

const FORGE_STEPS = [
  'Conceptualizing design...',
  'Selecting materials...',
  'Detailing the shape...',
  'Sculpting 3D model...',
  'Applying textures...',
  'Finishing touches...',
];

function ForgingScreen({ jobId, promptLabel, onDone, onError }: {
  jobId: string;
  promptLabel: string;
  onDone: (item: AvatarItemData) => void;
  onError: (msg: string) => void;
}) {
  const [stepIdx,  setStepIdx]  = useState(0);
  const [jobStatus, setJobStatus] = useState<'pending' | 'modeling'>('pending');
  const pollRef = useRef<any>(null);

  useEffect(() => {
    const t = setInterval(() => setStepIdx(i => Math.min(i + 1, FORGE_STEPS.length - 1)), 2400);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await apiGet<{ status: string; item?: AvatarItemData; error?: string }>(
          `/ai/generate-avatar-item/status/${jobId}`
        );
        if (r.status === 'done' && r.item) {
          clearInterval(pollRef.current);
          onDone(r.item);
        } else if (r.status === 'error') {
          clearInterval(pollRef.current);
          onError(r.error ?? 'Forge failed. Try a different prompt.');
        } else if (r.status === 'modeling') {
          setJobStatus('modeling');
        }
      } catch { /* keep polling */ }
    }, 2500);
    return () => clearInterval(pollRef.current);
  }, [jobId]);

  const statusLabel = jobStatus === 'modeling' ? 'Crafting 3D model...' : FORGE_STEPS[stepIdx];

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <view style={{ marginBottom: 28 }}>
        <Dots />
      </view>
      <text style={{ fontSize: 22, color: C.text, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
        Forging your asset
      </text>
      <text style={{ fontSize: 15, color: C.secondary, textAlign: 'center', marginBottom: 32 }}>
        {statusLabel}
      </text>
      <view style={{ width: '80%', height: 4, backgroundColor: C.card, borderRadius: 2, overflow: 'hidden', marginBottom: 28 }}>
        <view style={{
          height: '100%', backgroundColor: C.primary, borderRadius: 2,
          width: `${Math.round(((stepIdx + 1) / FORGE_STEPS.length) * 100)}%`,
        }} />
      </view>
      {promptLabel ? (
        <view style={{ backgroundColor: C.card, borderRadius: 14, paddingLeft: 20, paddingRight: 20, paddingTop: 12, paddingBottom: 12, borderWidth: 1, borderColor: C.border }}>
          <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center' }}>
            Forging <text style={{ color: C.primary, fontWeight: 'bold' }}>"{promptLabel}"</text>
          </text>
        </view>
      ) : null}
    </view>
  );
}

// ── Assets picker (catalog) ──────────────────────────────────────────────────

export function ShopScreen({ onBack, onApply, embedded = false }: Props) {
  const headerTop    = embedded ? 12 : safeAreaTop() + 8;
  const applyBarPad  = embedded ? 12 : 12 + safeAreaBottom();
  const [assets,       setAssets]       = useState<AssetItem[]>([]);
  const [search,       setSearch]       = useState('');
  const [selected,     setSelected]     = useState<Map<string, AssetItem>>(new Map());
  const [loading,      setLoading]      = useState(true);
  const [forgePhase,   setForgePhase]   = useState<ForgePhase>('catalog');
  const [forgeJobId,   setForgeJobId]   = useState('');
  const [forgeLabel,   setForgeLabel]   = useState('');
  const [forgeError,   setForgeError]   = useState('');

  function loadAssets() {
    setLoading(true);
    // 500 is the server-side cap on /api/assets — request the full ceiling so
    // every .glb in the R2 game-assets/v1/ prefix appears in the picker.
    fetchAssets('', 500).then(list => {
      setAssets(list);
      setLoading(false);
    });
  }

  useEffect(() => { loadAssets(); }, []);

  // Debounced query that actually drives the grid. `search` updates instantly so
  // the input stays responsive, but rebuilding up to 500 GameObject-backed tiles
  // on every keystroke is what made search laggy — so the heavy filter+render
  // only runs ~180 ms after typing pauses.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 180);
    return () => clearTimeout(t);
  }, [search]);

  // Client-side search filter — list is small enough that re-querying the server
  // per keystroke would be wasteful. Searches the editable title (when set)
  // and the raw prompt as a fallback, so both freshly-titled and not-yet-
  // titled assets surface for the right query.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter(a =>
      (a.title ?? '').toLowerCase().includes(q) ||
      a.prompt.toLowerCase().includes(q)
    );
  }, [assets, query]);

  const toggleSelect = useCallback((asset: AssetItem) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(asset.cacheKey)) next.delete(asset.cacheKey);
      else next.set(asset.cacheKey, asset);
      return next;
    });
  }, []);

  function applyNow() {
    if (!onApply || selected.size === 0) return;
    onApply(Array.from(selected.values()));
    setSelected(new Map());
    onBack();
  }

  async function startForge(prompt: string) {
    setForgeLabel(prompt.slice(0, 40));
    setForgeError('');
    try {
      const r = await apiPost<{ jobId: string }>('/ai/generate-avatar-item', {
        prompt,
        creatorName: 'Player',
      });
      setForgeJobId(r.jobId);
      setForgePhase('forging');
    } catch {
      setForgeError('Could not start forge — check your connection.');
      setForgePhase('prompt');
    }
  }

  function onForgeDone(_item: AvatarItemData) {
    setForgePhase('catalog');
    loadAssets(); // refresh so the newly-forged model appears
  }

  function onForgeError(msg: string) {
    setForgeError(msg);
    setForgePhase('prompt');
  }

  // ── Forge sub-phases ─────────────────────────────────────────────────────
  if (forgePhase === 'prompt') {
    return (
      <ForgePromptScreen
        onBack={() => { setForgePhase('catalog'); setForgeError(''); }}
        onForge={startForge}
        headerTop={headerTop}
      />
    );
  }
  if (forgePhase === 'forging') {
    return (
      <ForgingScreen
        jobId={forgeJobId}
        promptLabel={forgeLabel}
        onDone={onForgeDone}
        onError={onForgeError}
      />
    );
  }

  // ── Main Assets screen ───────────────────────────────────────────────────
  const showApplyBar = !!onApply && selected.size > 0;

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>

      {/* Header — back button, inline search bar, Forge. paddingBottom: 0
          and the scroll's paddingTop: 0 below sit the grid flush against the
          header's bottom border. */}
      <view style={{
        flexDirection: 'row', alignItems: 'center',
        paddingLeft: 12, paddingRight: 12, paddingTop: headerTop, paddingBottom: 12,
        borderBottomWidth: 1, borderBottomColor: C.border,
        gap: 10,
      }}>
        <GlassButton onClick={onBack} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4, flexShrink: 0 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.text, lineHeight: 24 }}>arrow_back</icon>
        </GlassButton>

        <view style={{
          flex: 1,
          backgroundColor: C.card, borderRadius: 12,
          borderWidth: 1, borderColor: C.border,
          flexDirection: 'row', alignItems: 'center',
          paddingLeft: 12, paddingRight: 12,
          minHeight: 44, height: 44,
        } as any}>
          <icon set="material-rounded" style={{ fontSize: 18, color: C.secondary, lineHeight: 18, marginRight: 8 }}>search</icon>
          <input
            value={search}
            onChange={(val: any) => setSearch(val)}
            placeholder="Search assets..."
            style={{
              flex: 1, fontSize: 14, lineHeight: 20, color: C.text,
              backgroundColor: 'transparent', borderWidth: 0,
              paddingTop: 6, paddingBottom: 6,
              minHeight: 32,
            }}
          />
          {search ? (
            <GlassButton onClick={() => setSearch('')} style={{
              backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4,
            }}>
              <icon set="material-rounded" style={{ fontSize: 16, color: C.secondary, lineHeight: 16 }}>close</icon>
            </GlassButton>
          ) : null}
        </view>

        <GlassButton onClick={() => setForgePhase('prompt')} style={{
          backgroundColor: C.primary, borderRadius: 10, borderWidth: 0,
          paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
          flexDirection: 'row', alignItems: 'center', gap: 4,
          flexShrink: 0,
        }}>
          <icon set="material-rounded" style={{ fontSize: 14, color: C.onPrimary, lineHeight: 14 }}>add</icon>
          <text style={{ fontSize: 13, color: C.onPrimary, fontWeight: 'bold' }}>Forge</text>
        </GlassButton>
      </view>

      {forgeError ? (
        <view style={{ marginLeft: 16, marginRight: 16, marginTop: 10, backgroundColor: 'rgba(255,69,58,0.12)', borderRadius: 10, paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10 }}>
          <text style={{ fontSize: 13, color: '#FF453A' }}>{forgeError}</text>
        </view>
      ) : null}

      {/* Asset grid — flush against the header (paddingTop: 0). Tiles are
          chunked into explicit row <view>s instead of using flex-wrap;
          ReactUnity's ScrollRect needs the content's total height to be
          knowable BEFORE the wrap pass to enable drag.
          `height: 1` is the Yoga seed-height trick (same pattern used by the
          working scrolls at CreateScreen.tsx:1399, 1806). Without it, Yoga
          sizes the scroll's height from its children, which means total
          content height always equals viewport height and ScrollRect decides
          nothing needs scrolling. With a tiny seed, `flex: 1` expands the
          scroll to fill the column but the children still get measured
          independently — content overflows, scroll activates. */}
      <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 0, paddingRight: 0, paddingTop: 0 } as any}>
        {loading ? (
          /* Skeleton mirrors the real grid's row/tile geometry so the layout
             doesn't jump when assets land. */
          <view style={{ flexDirection: 'column' }}>
            {Array.from({ length: 4 }, (_, rowIdx) => (
              <view key={rowIdx} style={{ flexDirection: 'row', height: 110 } as any}>
                {Array.from({ length: SHOP_GRID_COLS }, (_, colIdx) => (
                  <view key={colIdx} style={{ width: `${100 / SHOP_GRID_COLS}%`, height: 110, padding: 1 } as any}>
                    <Skeleton width="100%" height="100%" radius={0} />
                  </view>
                ))}
              </view>
            ))}
          </view>
        ) : filtered.length === 0 ? (
          <view style={{ alignItems: 'center', paddingTop: 48, paddingBottom: 48, gap: 10 }}>
            <icon set="material-rounded" style={{ fontSize: 40, color: C.surface, lineHeight: 40 }}>inventory_2</icon>
            <text style={{ fontSize: 16, color: C.text, fontWeight: 'bold', textAlign: 'center' }}>
              {search ? 'No matching assets' : 'No assets yet'}
            </text>
            <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center', lineHeight: 18 }}>
              Tap <text style={{ color: C.primary, fontWeight: 'bold' }}>+ Forge</text> to generate a new 3D asset.
            </text>
          </view>
        ) : (
          <view style={{ flexDirection: 'column', paddingBottom: showApplyBar ? 140 : 0 } as any}>
            {Array.from({ length: Math.ceil(filtered.length / SHOP_GRID_COLS) }, (_, rowIdx) => {
              const row = filtered.slice(rowIdx * SHOP_GRID_COLS, rowIdx * SHOP_GRID_COLS + SHOP_GRID_COLS);
              return (
                <view key={rowIdx} style={{ flexDirection: 'row', height: 110 } as any}>
                  {row.map(asset => (
                    <view key={asset.cacheKey} style={{ width: `${100 / SHOP_GRID_COLS}%`, height: 110 } as any}>
                      <AssetTile
                        asset={asset}
                        selected={selected.has(asset.cacheKey)}
                        onPress={toggleSelect}
                      />
                    </view>
                  ))}
                </view>
              );
            })}
          </view>
        )}
      </scroll>

      {/* Apply bar — horizontal scroll of selected items + Apply button. */}
      {showApplyBar ? (
        <view style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          ...glass({ fill: 'rgba(20,20,22,0.96)' }),
          borderTopWidth: 1, borderTopColor: C.border,
          paddingLeft: 12, paddingRight: 12, paddingTop: 12, paddingBottom: applyBarPad,
          flexDirection: 'row', alignItems: 'center', gap: 10,
        }}>
          <scroll horizontal className="pludo-scroll" style={{ flex: 1 }}>
            <view style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 4 }}>
              {Array.from(selected.values()).map(a => (
                <view key={a.cacheKey} style={{ position: 'relative' }}>
                  <AssetTile
                    asset={a}
                    selected={true}
                    onPress={toggleSelect}
                    size={56}
                  />
                </view>
              ))}
            </view>
          </scroll>
          <GlassButton onClick={applyNow} style={{
            backgroundColor: C.primary, borderRadius: 14, borderWidth: 0,
            paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12,
            flexShrink: 0,
          }}>
            <text style={{ fontSize: 14, color: C.onPrimary, fontWeight: 'bold' }}>
              Apply ({selected.size})
            </text>
          </GlassButton>
        </view>
      ) : null}
    </view>
  );
}
