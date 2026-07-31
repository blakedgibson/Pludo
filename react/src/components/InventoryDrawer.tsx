import React, { useState, useRef, useEffect } from 'react';
import { C } from '../theme';
import { CARD_WIDTH_PCT } from '../responsive';

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

const RARITY_COLOR: Record<Rarity, string> = {
  Common:    C.secondary,
  Uncommon:  C.green,
  Rare:      '#00D4FF',
  Epic:      '#BF5AF2',
  Legendary: C.orange,
};

// Map Unity category strings → UI filter category
function toFilterCat(cat: string): Category {
  const c = cat.toLowerCase();
  if (['top', 'tops', 'bottom', 'bottoms', 'shoes'].includes(c)) return 'Clothing';
  if (['head', 'hair', 'faces', 'face'].includes(c)) return 'Body';
  if (['neck', 'front', 'back', 'waist', 'accessory', 'accessories'].includes(c)) return 'Accessories';
  return 'Accessories';
}

const CATS: Category[] = ['All', 'Accessories', 'Clothing', 'Body'];

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

export function InventoryDrawer() {
  const [panelHeight, setPanelHeight] = useState(0);
  const [cat,         setCat]         = useState<Category>('All');
  const [items,       setItems]       = useState<InvItem[]>([]);

  const animRef    = useRef<any>(null);
  const lastDragY  = useRef(0);
  const hasDragged = useRef(false);
  const panelHRef  = useRef(0);

  useEffect(() => () => { if (animRef.current) clearInterval(animRef.current); }, []);

  // Poll Unity for the player's real inventory
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
    const scale = getScreenH() / 844;
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
          backgroundColor: h > 10 ? C.green : C.surface,
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

            {/* Category tabs */}
            <view style={{
              flexDirection: 'row',
              paddingLeft: 14, paddingRight: 14,
              paddingTop: 10, paddingBottom: 8,
              gap: 8, flexShrink: 0,
            }}>
              {CATS.map(c => {
                const active = c === cat;
                return (
                  <button key={c} onClick={() => setCat(c)} style={{
                    paddingLeft: 14, paddingRight: 14,
                    paddingTop: 6, paddingBottom: 6,
                    borderRadius: 20,
                    backgroundColor: active ? C.green : C.surface,
                    borderWidth: 0,
                  }}>
                    <text style={{ fontSize: 12, fontWeight: 'bold', color: active ? C.bg : C.secondary }}>
                      {c}
                    </text>
                  </button>
                );
              })}
            </view>

            {/* Item grid or empty state */}
            <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 12, paddingRight: 12 }}>
              {filtered.length > 0 ? (
                <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingBottom: 16 }}>
                  {filtered.map((item, idx) => <InvCard key={String(item.id ?? idx)} item={item} />)}
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

          </view>
        )}
      </view>

    </view>
  );
}

function InvCard({ item }: { item: InvItem }) {
  const rarity = (item.rarity ?? 'Common') as Rarity;
  const color  = RARITY_COLOR[rarity] ?? C.secondary;
  return (
    <view style={{
      width: CARD_WIDTH_PCT,
      backgroundColor: C.surface,
      borderRadius: 14,
      borderWidth: item.equipped ? 1.5 : 1,
      borderColor: item.equipped ? C.green : C.border,
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
            backgroundColor: 'rgba(48,209,88,0.2)',
            borderRadius: 4,
            paddingLeft: 5, paddingRight: 5,
            paddingTop: 2, paddingBottom: 2,
          }}>
            <text style={{ fontSize: 9, color: C.green, fontWeight: 'bold' }}>ON</text>
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
