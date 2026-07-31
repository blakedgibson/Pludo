import React, { useState } from 'react';
import { C } from '../theme';
import { CONTENT_MAX_WIDTH } from '../responsive';
import { FriendData } from '../types';
import { safeAreaTop } from '../safeArea';
import { Pressable } from '../components/Pressable';

interface Message { id: string; from: 'me' | 'them'; text: string; }

interface Chat {
  id: string;
  name: string;
  initial: string;
  online: boolean;
}

function friendToChat(f: FriendData): Chat {
  const initial = f.name.trim().split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return { id: f.id, name: f.name, initial, online: f.status !== 'offline' };
}

export function ChatScreen({ friends }: { friends: FriendData[] }) {
  const [active,   setActive]   = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [draft,    setDraft]    = useState('');

  const chats = friends.map(friendToChat);

  function openThread(chat: Chat) {
    setActive(chat);
    setDraft('');
  }

  function sendMessage() {
    if (!active || !draft.trim()) return;
    const msg: Message = { id: Date.now().toString(), from: 'me', text: draft.trim() };
    setMessages(prev => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), msg] }));
    setDraft('');
  }

  function lastPreview(chatId: string): string {
    const msgs = messages[chatId];
    if (!msgs || msgs.length === 0) return '';
    const last = msgs[msgs.length - 1];
    const prefix = last.from === 'me' ? 'You: ' : '';
    return prefix + last.text.slice(0, 45);
  }

  // ── Thread view ──────────────────────────────────────────────────────────────
  if (active) {
    const threadMsgs = messages[active.id] ?? [];
    return (
      <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>

        <view style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 12 }}>
          <button onClick={() => setActive(null)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
            <icon set="material-rounded" style={{ fontSize: 24, color: C.green, lineHeight: 24 }}>arrow_back</icon>
          </button>
          <view style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
            <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold' }}>{active.initial}</text>
          </view>
          <view style={{ flex: 1 }}>
            <text style={{ fontSize: 17, color: C.text, fontWeight: 'bold' }}>{active.name}</text>
            {active.online ? (
              <view style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <icon set="material-rounded-filled" style={{ fontSize: 10, color: C.green, lineHeight: 10 }}>circle</icon>
                <text style={{ fontSize: 11, color: C.green }}>Online</text>
              </view>
            ) : (
              <text style={{ fontSize: 11, color: C.secondary }}>Offline</text>
            )}
          </view>
        </view>

        <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 12 }}>
          {threadMsgs.length === 0 ? (
            <view style={{ alignItems: 'center', paddingTop: 40, gap: 6 }}>
              <icon set="material-rounded" style={{ fontSize: 32, color: C.secondary, lineHeight: 32 }}>chat_bubble_outline</icon>
              <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center' }}>
                Say hello to {active.name}!
              </text>
            </view>
          ) : null}
          {threadMsgs.map(m => (
            <view key={m.id} style={{ flexDirection: 'row', justifyContent: m.from === 'me' ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
              <view style={{ maxWidth: '72%', paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, borderRadius: 18, backgroundColor: m.from === 'me' ? C.green : C.card }}>
                <text style={{ fontSize: 15, color: m.from === 'me' ? C.bg : C.text }}>{m.text}</text>
              </view>
            </view>
          ))}
        </scroll>

        <view style={{ flexDirection: 'row', padding: 12, gap: 10, borderTopWidth: 1, borderTopColor: C.border }}>
          <input
            value={draft}
            onChange={(e: any) => setDraft(e.target?.value ?? e)}
            placeholder="Message..."
            style={{ flex: 1, backgroundColor: C.card, borderRadius: 22, paddingLeft: 16, paddingRight: 16, paddingTop: 10, paddingBottom: 10, fontSize: 15, color: C.text, borderWidth: 0 }}
          />
          <Pressable onClick={sendMessage} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }}>
            <icon set="material-rounded-filled" style={{ fontSize: 20, color: C.bg, lineHeight: 20 }}>send</icon>
          </Pressable>
        </view>

      </view>
      </view>
    );
  }

  // ── Chat list ────────────────────────────────────────────────────────────────
  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>

      <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 16 }}>
        <text style={{ fontSize: 34, color: C.text, fontWeight: 'bold', letterSpacing: -0.5 }}>Chat</text>
      </view>

      {chats.length === 0 ? (
        <view style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingLeft: 32, paddingRight: 32 }}>
          <icon set="material-rounded" style={{ fontSize: 44, color: C.secondary, lineHeight: 44 }}>forum</icon>
          <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold', textAlign: 'center' }}>No messages yet</text>
          <text style={{ fontSize: 14, color: C.secondary, textAlign: 'center', lineHeight: 20 }}>
            Friend someone from the Home tab to start chatting.
          </text>
        </view>
      ) : (
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1 }}>
          {chats.map((chat, index) => {
            const preview = lastPreview(chat.id);
            return (
              <view key={chat.id}>
                <button
                  onClick={() => openThread(chat)}
                  style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14, backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0 }}
                >
                  <view style={{ position: 'relative', marginRight: 12, flexShrink: 0 }}>
                    <view style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' }}>
                      <text style={{ fontSize: 18, color: C.text, fontWeight: 'bold' }}>{chat.initial}</text>
                    </view>
                    {chat.online && (
                      <view style={{ position: 'absolute', bottom: 1, right: 1, width: 13, height: 13, borderRadius: 7, backgroundColor: C.green, borderWidth: 2, borderColor: C.bg }} />
                    )}
                  </view>
                  <view style={{ flex: 1, marginRight: 10 }}>
                    <text style={{ fontSize: 16, color: C.text, fontWeight: 'bold', marginBottom: 2 }}>{chat.name}</text>
                    <text style={{ fontSize: 13, color: C.secondary }}>
                      {preview || 'Tap to say hello'}
                    </text>
                  </view>
                </button>
                {index < chats.length - 1 && <view style={{ height: 1, backgroundColor: C.border, marginLeft: 80 }} />}
              </view>
            );
          })}
        </scroll>
      )}

      </view>
    </view>
  );
}
