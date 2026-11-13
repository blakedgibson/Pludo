import React, { useState, useRef, useEffect } from 'react';
import { C, RARITY } from '../theme';
import { CARD_WIDTH_PCT, refScreenHeight } from '../responsive';
import { safeAreaTop } from '../safeArea';
import { GlassButton } from './GlassButton';

type Category = 'All' | 'Accessories' | 'Clothing' | 'Body';

type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';

interface InvItem {
  id: string | number;
  name: string;
  category: string;
  rarity: Rarity;
  equipped?: boolean;
  price?: number;
  imageUrl?: string;
  thumbnailUrl?: string;
}

// Map Unity category strings → UI filter category
function toFilterCat(cat: string): Category {
  const c = cat.toLowerCase();
  if (['top', 'tops', 'bottom', 'bottoms', 'shoes'].includes(c)) return 'Clothing';
  if (['head', 'hair', 'faces', 'face'].includes(c)) return 'Body';
  if (['neck', 'front', 'back', 'waist', 'accessory', 'accessories'].includes(c)) return 'Accessories';
  return 'Accessories';
}

const CATS: Category[] = ['All', 'Accessories', 'Clothing', 'Body'];

// The tablet panel is a narrow column, so the shared 3-up tablet grid width
// would produce ~90px cards. Two per row keeps the thumbnails readable.
const PANEL_CARD_WIDTH_PCT = '47%';

// Wardrobe panel width for the tablet split view. Proportional to the space
// left after the nav rail (so an iPad mini doesn't get the same 400px slab as
// a 12.9"), clamped so the item grid stays usable at the low end and the chibi
// column doesn't get starved at the high end.
export function wardrobePanelWidth(availableWidth: number): number {
  return Math.round(Math.max(260, Math.min(400, availableWidth * 0.5)));
}

const DRAWER_HALF = 380;
const DRAWER_FULL = 660;
const LERP_SPEED  = 0.28;
const SNAP_TO_FULL = DRAWER_FULL * 0.75;
const SNAP_TO_HALF = DRAWER_HALF * 0.40;

function getPointerY(): number {
  return (Globals['getPointerY'] as any)?.() ?? 0;
}
function getScreenH(): number {
  return (Globals['getScreenHeight'] as any)?.() ?? 844;
}

// Polls Unity for the player's real inventory. Shared by the phone drawer and
// the tablet side panel so both always show the same list from the same source.
function useInventory(): InvItem[] {
  const [items, setItems] = useState<InvItem[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      try {
        const raw = String((Globals as any)._inventoryJson ?? '');
        if (!raw) return;
        const parsed = JSON.parse(raw) as { items?: InvItem[] };
        const list = parsed.items ?? [];
        setItems(prev => {
          // Avoid re-render if data hasn't changed
          return JSON.stringify(prev) === JSON.stringify(list) ? prev : list;
        });
      } catch { /* JSON not ready yet */ }
    }, 500);
    return () => clearInterval(t);
  }, []);
  return items;
}

function CategoryTabs({ cat, onCat }: { cat: Category; onCat: (c: Category) => void }) {
  return (
    <view style={{
      flexDirection: 'row',
      paddingLeft: 14, paddingRight: 14,
      paddingTop: 10, paddingBottom: 8,
      gap: 8, flexShrink: 0,
    }}>
      {CATS.map(c => {
        const active = c === cat;
        return (
          <GlassButton key={c} onClick={() => onCat(c)} style={{
            paddingLeft: 14, paddingRight: 14,
            paddingTop: 6, paddingBottom: 6,
            borderRadius: 20,
            backgroundColor: active ? C.primary : C.surface,
            borderWidth: 0,
          }}>
            <text style={{ fontSize: 12, fontWeight: 'bold', color: active ? C.onPrimary : C.secondary }}>
              {c}
            </text>
          </GlassButton>
        );
      })}
    </view>
  );
}

// `widthPct` differs per host: the drawer spans the full screen and uses the
// shared responsive grid width, while the tablet panel is a narrow column and
// needs its own 2-up value.
function ItemGrid({ items, filtered, widthPct }:
  { items: InvItem[]; filtered: InvItem[]; widthPct: string }) {
  return (
    <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 12, paddingRight: 12 }}>
      {filtered.length > 0 ? (
        <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 16 }}>
          {filtered.map((item, idx) => (
            <InvCard key={String(item.id ?? idx)} item={item} widthPct={widthPct} />
          ))}
        </view>
      ) : (
        <view style={{ alignItems: 'center', justifyContent: 'center', paddingTop: 32, paddingBottom: 32, gap: 8 }}>
          <icon set="material-rounded" style={{ fontSize: 32, color: C.surface, lineHeight: 32 }}>inventory_2</icon>
          <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center' }}>
            {items.length === 0 ? 'No items yet.\nVisit the shop to get some!' : 'No items in this category.'}
          </text>
        </view>
      )}
    </scroll>
  );
}

// Tablet wardrobe: a permanently-open right-hand column instead of the phone's
// drag-up drawer. There's no drag handle and no setDrawerHeight push — the
// chibi keeps a fixed left column (see AvatarScreen's setAvatarRegion call)
// rather than being shoved around by a moving sheet.
export function WardrobePanel({ width }: { width: number }) {
  const [cat, setCat] = useState<Category>('All');
  const items    = useInventory();
  const filtered = items.filter(i => cat === 'All' || toFilterCat(i.category) === cat);

  return (
    <view style={{
      width,
      flexShrink: 0,
      height: '100%',
      flexDirection: 'column',
      backgroundColor: C.card,
      borderLeftWidth: 1,
      borderLeftColor: C.border,
    }}>
      <view style={{
        paddingLeft: 16, paddingRight: 16,
        paddingTop: safeAreaTop() + 4, paddingBottom: 4,
        flexShrink: 0,
      }}>
        <text style={{ fontSize: 22, color: C.text, fontWeight: 'bold', letterSpacing: -0.3 }}>Wardrobe</text>
      </view>

      <CategoryTabs cat={cat} onCat={setCat} />
      <ItemGrid items={items} filtered={filtered} widthPct={PANEL_CARD_WIDTH_PCT} />
    </view>
  );
}

export function InventoryDrawer() {
  const [panelHeight, setPanelHeight] = useState(0);
  const [cat,         setCat]         = useState<Category>('All');
  const items = useInventory();

  const animRef    = useRef<any>(null);
  const lastDragY  = useRef(0);
  const hasDragged = useRef(false);
  const panelHRef  = useRef(0);

  useEffect(() => () => { if (animRef.current) clearInterval(animRef.current); }, []);

  function pushHeight(h: number) {
    (Globals['setDrawerHeight'] as ((h: number) => void) | undefined)?.(h);
  }

  function slideTo(target: number) {
    if (animRef.current) clearInterval(animRef.current);
    pushHeight(target);
    animRef.current = setInterval(() => {
      setPanelHeight(prev => {
        const next = prev + (target - prev) * LERP_SPEED;
        const done = Math.abs(target - next) < 1;
        const h    = done ? target : next;
        panelHRef.current = h;
        if (!done) pushHeight(h);
        if (done) { clearInterval(animRef.current); animRef.current = null; }
        return h;
      });
    }, 16);
  }

  function handlePointerDown(_e: any) {
    if (animRef.current) { clearInterval(animRef.current); animRef.current = null; }
    hasDragged.current = false;
    lastDragY.current  = getPointerY();
  }

  function handleBeginDrag(_e: any) {
    hasDragged.current = true;
    lastDragY.current  = getPointerY();
  }

  function handleDrag(_e: any) {
    hasDragged.current = true;
    const y     = getPointerY();
    const dy    = y - lastDragY.current;
    lastDragY.current = y;
    const scale = getScreenH() / refScreenHeight();
    const dyRef = dy / (scale || 1);
    const newH  = Math.max(0, Math.min(DRAWER_FULL, panelHRef.current + dyRef));
    panelHRef.current = newH;
    setPanelHeight(newH);
    pushHeight(newH);
  }

  function handlePointerUp(_e: any) {
    if (!hasDragged.current) {
      slideTo(panelHRef.current > DRAWER_HALF * 0.3 ? 0 : DRAWER_HALF);
      return;
    }
    hasDragged.current = false;
    const h = panelHRef.current;
    if (h > SNAP_TO_FULL)      slideTo(DRAWER_FULL);
    else if (h > SNAP_TO_HALF) slideTo(DRAWER_HALF);
    else                       slideTo(0);
  }

  const h = Math.round(panelHeight);
  const filtered = items.filter(i => cat === 'All' || toFilterCat(i.category) === cat);

  return (
    <view style={{ flexShrink: 0, flexDirection: 'column' }}>

      {/* Handle */}
      <view
        onPointerDown={handlePointerDown}
        onBeginDrag={handleBeginDrag}
        onDrag={handleDrag}
        onPointerUp={handlePointerUp}
        style={{
          alignItems: 'center',
          backgroundColor: C.card,
          borderTopWidth: 1,
          borderTopColor: C.border,
          paddingTop: 14,
          paddingBottom: 14,
          cursor: 'pointer',
        }}
      >
        <view style={{
          width: 36, height: 4, borderRadius: 2,
          backgroundColor: h > 10 ? C.primary : C.surface,
        }} />
      </view>

      {/* Sliding panel */}
      <view style={{
        height: h,
        backgroundColor: C.card,
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {h > 10 && (
          <view style={{ flex: 1, flexDirection: 'column' }}>
            <CategoryTabs cat={cat} onCat={setCat} />
            <ItemGrid items={items} filtered={filtered} widthPct={CARD_WIDTH_PCT} />
          </view>
        )}
      </view>

    </view>
  );
}

function InvCard({ item, widthPct }: { item: InvItem; widthPct: string }) {
  const color = RARITY[item.rarity ?? 'Common'] ?? C.secondary;
  return (
    <view style={{
      width: widthPct,
      backgroundColor: C.surface,
      borderRadius: 14,
      borderWidth: item.equipped ? 1.5 : 1,
      borderColor: item.equipped ? C.primary : C.border,
      overflow: 'hidden',
    }}>
      <view style={{
        height: 76,
        backgroundColor: 'rgba(0,0,0,0.25)',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {item.thumbnailUrl || item.imageUrl ? (
          <image src={item.thumbnailUrl ?? item.imageUrl} style={{ width: '100%', height: '100%' }} />
        ) : (
          <icon set="material-rounded-filled" style={{ fontSize: 28, color, lineHeight: 28 }}>diamond</icon>
        )}
        {item.equipped && (
          <view style={{
            position: 'absolute', top: 6, right: 6,
            backgroundColor: C.primaryTint,
            borderRadius: 4,
            paddingLeft: 5, paddingRight: 5,
            paddingTop: 2, paddingBottom: 2,
          }}>
            <text style={{ fontSize: 9, color: C.primary, fontWeight: 'bold' }}>ON</text>
          </view>
        )}
      </view>

      <view style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 8, gap: 3 }}>
        <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>{item.name}</text>
        <view style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <view style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
          <text style={{ fontSize: 11, color: C.secondary }}>{item.category}</text>
        </view>
      </view>
    </view>
  );
}
