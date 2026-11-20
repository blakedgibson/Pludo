import React, { useMemo, useState } from 'react';
import { C } from '../theme';
import { MATERIAL_ICON_NAMES } from '../generated/materialIconNames';
import { GlassButton } from './GlassButton';

// A small, curated set shown before the user types a search — the full
// 4250-name catalog is only ever narrowed by search, never rendered at once.
const DEFAULT_ICON_NAMES = [
  'star', 'favorite', 'bolt', 'diamond', 'emoji_events', 'shield',
  'sports_esports', 'shopping_cart', 'map', 'chat_bubble', 'leaderboard',
  'settings', 'help', 'swords', 'science', 'card_giftcard', 'notifications',
  'home', 'add_circle', 'lock', 'key', 'flag', 'rocket_launch', 'palette',
  'music_note', 'camera', 'photo', 'group', 'person', 'public', 'timer',
  'bar_chart', 'inventory_2', 'local_fire_department', 'ac_unit', 'pets',
];

const RESULT_CAP = 60;

export function IconPicker(props: {
  value?: string;
  onPick: (name: string) => void;
  iconSet?: string; // defaults to 'material-rounded'
}) {
  const set = props.iconSet ?? 'material-rounded';
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DEFAULT_ICON_NAMES;
    const out: string[] = [];
    for (let i = 0; i < MATERIAL_ICON_NAMES.length && out.length < RESULT_CAP; i++) {
      const name = MATERIAL_ICON_NAMES[i];
      if (name.includes(q)) out.push(name);
    }
    return out;
  }, [query]);

  return (
    <view style={{ flexDirection: 'column', gap: 8 }}>
      <input
        value={query}
        onChange={(e: any) => setQuery(e?.target?.value ?? e ?? '')}
        placeholder="Search icons… (e.g. star, cart, map)"
        style={{
          fontSize: 12, color: '#fff', backgroundColor: 'rgba(255,255,255,0.08)',
          borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
          paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
        }}
      />
      <view style={{ flexDirection: 'row', flexWrap: 'wrap' as any, gap: 6 }}>
        {results.map(name => {
          const active = props.value === name;
          return (
            <GlassButton
              key={name}
              onClick={() => props.onPick(name)}
              style={{
                width: 38, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
                backgroundColor: active ? 'rgba(30,140,255,0.25)' : 'rgba(255,255,255,0.07)',
                borderWidth: 1, borderColor: active ? C.blue : 'rgba(255,255,255,0.08)',
              }}
            >
              <icon set={set} style={{ fontSize: 19, lineHeight: 19, color: active ? C.blue : C.text }}>{name}</icon>
            </GlassButton>
          );
        })}
        {results.length === 0 ? (
          <text style={{ fontSize: 11, color: C.secondary, padding: 6 }}>No icons match "{query}"</text>
        ) : null}
      </view>
    </view>
  );
}
