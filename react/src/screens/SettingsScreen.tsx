import React, { useEffect, useState } from 'react';
import { C } from '../theme';
import { CONTENT_MAX_WIDTH } from '../responsive';
import { safeAreaTop } from '../safeArea';

// ── Shared UI primitives ─────────────────────────────────────────────────────

type SubScreen =
  | 'index'
  | 'account'
  | 'notifications'
  | 'privacy'
  | 'display'
  | 'sound'
  | 'help'
  | 'about';

function getPref(key: string, def: string): string {
  try { return String((Globals as any).getPref?.(key, def) ?? def); } catch { return def; }
}
function setPref(key: string, value: string) {
  try { (Globals as any).setPref?.(key, value); } catch { /* no-op */ }
}
function getBoolPref(key: string, def: boolean): boolean {
  const raw = getPref(key, def ? '1' : '0');
  return raw === '1' || raw === 'true';
}
function setBoolPref(key: string, value: boolean) { setPref(key, value ? '1' : '0'); }

interface SubProps { onBack: () => void; title: string; children: React.ReactNode; }

function SubScreenShell({ onBack, title, children }: SubProps) {
  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>
        <view style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 12, gap: 12 }}>
          <button onClick={onBack} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
            <icon set="material-rounded" style={{ fontSize: 24, color: C.green, lineHeight: 24 }}>arrow_back</icon>
          </button>
          <text style={{ fontSize: 24, color: C.text, fontWeight: 'bold', flex: 1 }}>{title}</text>
        </view>
        <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 4 }}>
          {children}
        </scroll>
      </view>
    </view>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <view style={{ backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden', marginBottom: 16 }}>
      {children}
    </view>
  );
}

function Divider() {
  return <view style={{ height: 1, backgroundColor: C.border, marginLeft: 16 }} />;
}

interface ToggleRowProps { label: string; sublabel?: string; value: boolean; onChange: (v: boolean) => void; }
function ToggleRow({ label, sublabel, value, onChange }: ToggleRowProps) {
  return (
    <button onClick={() => onChange(!value)} style={{
      paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14,
      backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0,
    }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <view style={{ flex: 1 }}>
          <text style={{ fontSize: 15, color: C.text }}>{label}</text>
          {sublabel ? <text style={{ fontSize: 12, color: C.secondary, marginTop: 2 }}>{sublabel}</text> : null}
        </view>
        <view style={{
          width: 44, height: 26, borderRadius: 13,
          backgroundColor: value ? C.green : 'rgba(255,255,255,0.15)',
          justifyContent: 'center', paddingLeft: 3, paddingRight: 3,
          flexDirection: 'row', alignItems: 'center',
        }}>
          <view style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff',
            marginLeft: value ? 18 : 0, marginRight: value ? 0 : 18 }} />
        </view>
      </view>
    </button>
  );
}

interface InfoRowProps { label: string; value: string; mono?: boolean; }
function InfoRow({ label, value, mono }: InfoRowProps) {
  return (
    <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14,
      flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <text style={{ fontSize: 15, color: C.secondary, flex: 1 }}>{label}</text>
      <text style={{ fontSize: 14, color: C.text, fontFamily: mono ? 'monospace' : undefined as any }}>{value}</text>
    </view>
  );
}

// ── Account ──────────────────────────────────────────────────────────────────

function AccountScreen({ onBack }: { onBack: () => void }) {
  const [username,    setUsername]    = useState('');
  const [email,       setEmail]       = useState('');
  const [userId,      setUserId]      = useState('');
  const [displayName, setDisplayName] = useState('');
  const [draft,       setDraft]       = useState('');
  const [saving,      setSaving]      = useState(false);
  const [status,      setStatus]      = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    try {
      setUsername(String((Globals as any).currentUsername?.()  ?? ''));
      setEmail(   String((Globals as any).currentUserEmail?.() ?? ''));
      setUserId(  String((Globals as any).currentUserId?.()    ?? ''));
    } catch { /* not ready */ }

    // fetchMyProfile returns JSON with the real display name (falls back to username).
    try {
      const p = (Globals as any).fetchMyProfile?.();
      Promise.resolve(p).then((raw: any) => {
        if (!raw) return;
        try {
          const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const dn = j?.displayName ?? j?.username ?? '';
          setDisplayName(String(dn));
          setDraft(String(dn));
        } catch { /* ignore */ }
      }).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }, []);

  const trimmed = draft.trim();
  const canSave = !saving && trimmed.length >= 2 && trimmed.length <= 40 && trimmed !== displayName;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setStatus(null);
    try {
      const err = await Promise.resolve((Globals as any).updateMyProfile?.(trimmed));
      if (err) {
        setStatus({ kind: 'err', msg: String(err) });
      } else {
        setDisplayName(trimmed);
        setStatus({ kind: 'ok', msg: 'Display name updated.' });
      }
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.message ?? 'Update failed.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SubScreenShell onBack={onBack} title="Account">
      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>YOUR INFO</text>
      <Card>
        <InfoRow label="Username" value={username || '—'} />
        <Divider />
        <InfoRow label="Email"    value={email    || '—'} />
        <Divider />
        <InfoRow label="User ID"  value={userId ? userId.slice(0, 8) + '…' : '—'} mono />
      </Card>

      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>DISPLAY NAME</text>
      <Card>
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
          <input
            value={draft}
            onChange={(e: any) => setDraft(e?.target?.value ?? e)}
            placeholder="Display name"
            maxLength={40}
            style={{
              fontSize: 16, color: C.text,
              backgroundColor: 'rgba(255,255,255,0.05)',
              borderWidth: 1, borderColor: C.border,
              borderRadius: 10,
              paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10,
            }}
          />
          <text style={{ fontSize: 11, color: C.secondary, marginTop: 6 }}>
            Shown on your public profile and to friends. 2–40 characters.
          </text>
        </view>
      </Card>

      <button onClick={save} style={{
        backgroundColor: canSave ? C.green : 'rgba(255,255,255,0.08)',
        borderRadius: 14, borderWidth: 0,
        paddingTop: 14, paddingBottom: 14,
        alignItems: 'center', justifyContent: 'center',
        marginBottom: 12,
      }}>
        <text style={{ fontSize: 15, color: canSave ? '#fff' : C.secondary, fontWeight: 'bold' }}>
          {saving ? 'Saving…' : 'Save changes'}
        </text>
      </button>

      {status ? (
        <text style={{ fontSize: 13, color: status.kind === 'ok' ? C.green : C.red, textAlign: 'center', marginBottom: 24 }}>
          {status.msg}
        </text>
      ) : null}
    </SubScreenShell>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const [friend,    setFriend]    = useState(() => getBoolPref('notif.friend',    true));
  const [mention,   setMention]   = useState(() => getBoolPref('notif.mention',   true));
  const [updates,   setUpdates]   = useState(() => getBoolPref('notif.updates',   true));
  const [marketing, setMarketing] = useState(() => getBoolPref('notif.marketing', false));

  function bind(key: string, set: (v: boolean) => void) {
    return (v: boolean) => { set(v); setBoolPref(key, v); };
  }

  return (
    <SubScreenShell onBack={onBack} title="Notifications">
      <Card>
        <ToggleRow label="Friend requests"   sublabel="Notify when someone adds you" value={friend}    onChange={bind('notif.friend',    setFriend)} />
        <Divider />
        <ToggleRow label="Mentions & chat"   sublabel="In-game and DM activity"      value={mention}   onChange={bind('notif.mention',   setMention)} />
        <Divider />
        <ToggleRow label="Game updates"      sublabel="New features and events"      value={updates}   onChange={bind('notif.updates',   setUpdates)} />
        <Divider />
        <ToggleRow label="Marketing emails"  sublabel="Tips and announcements"       value={marketing} onChange={bind('notif.marketing', setMarketing)} />
      </Card>
    </SubScreenShell>
  );
}

// ── Privacy ──────────────────────────────────────────────────────────────────

function PrivacyScreen({ onBack }: { onBack: () => void }) {
  const [pub,    setPub]    = useState(() => getBoolPref('privacy.publicProfile',  true));
  const [reqs,   setReqs]   = useState(() => getBoolPref('privacy.allowRequests',  true));
  const [online, setOnline] = useState(() => getBoolPref('privacy.showOnline',     true));

  function bind(key: string, set: (v: boolean) => void) {
    return (v: boolean) => { set(v); setBoolPref(key, v); };
  }

  return (
    <SubScreenShell onBack={onBack} title="Privacy">
      <Card>
        <ToggleRow label="Public profile"          sublabel="Anyone can see your games" value={pub}    onChange={bind('privacy.publicProfile', setPub)} />
        <Divider />
        <ToggleRow label="Allow friend requests"   sublabel="Let other players add you" value={reqs}   onChange={bind('privacy.allowRequests', setReqs)} />
        <Divider />
        <ToggleRow label="Show online status"      sublabel="Friends see when you're active" value={online} onChange={bind('privacy.showOnline', setOnline)} />
      </Card>
    </SubScreenShell>
  );
}

// ── Display ──────────────────────────────────────────────────────────────────

function DisplayScreen({ onBack }: { onBack: () => void }) {
  const [reduceMotion, setReduceMotion] = useState(() => getBoolPref('display.reduceMotion', false));
  const [haptics,      setHaptics]      = useState(() => getBoolPref('display.haptics',      true));
  const [scale,        setScale]        = useState(() => getPref('display.uiScale', 'normal'));

  function bindBool(key: string, set: (v: boolean) => void) {
    return (v: boolean) => { set(v); setBoolPref(key, v); };
  }

  const SCALES: Array<{ key: string; label: string }> = [
    { key: 'small',  label: 'S' },
    { key: 'normal', label: 'M' },
    { key: 'large',  label: 'L' },
  ];

  function pickScale(k: string) { setScale(k); setPref('display.uiScale', k); }

  return (
    <SubScreenShell onBack={onBack} title="Display">
      <Card>
        <ToggleRow label="Reduce motion"     sublabel="Limit animations and parallax" value={reduceMotion} onChange={bindBool('display.reduceMotion', setReduceMotion)} />
        <Divider />
        <ToggleRow label="Haptic feedback"   sublabel="Vibrate on key actions"        value={haptics}      onChange={bindBool('display.haptics',      setHaptics)} />
      </Card>

      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>UI SCALE</text>
      <Card>
        <view style={{ flexDirection: 'row', padding: 8, gap: 8 }}>
          {SCALES.map(s => {
            const active = s.key === scale;
            return (
              <button key={s.key} onClick={() => pickScale(s.key)} style={{
                flex: 1,
                paddingTop: 12, paddingBottom: 12,
                borderRadius: 10, borderWidth: 1,
                borderColor: active ? C.green : C.border,
                backgroundColor: active ? 'rgba(48,209,88,0.12)' : 'rgba(255,255,255,0.04)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <text style={{ fontSize: 14, color: active ? C.green : C.text, fontWeight: 'bold' }}>{s.label}</text>
              </button>
            );
          })}
        </view>
      </Card>
    </SubScreenShell>
  );
}

// ── Sound ────────────────────────────────────────────────────────────────────

function SoundScreen({ onBack }: { onBack: () => void }) {
  const [volume, setVolume] = useState<number>(() => {
    try { return Number((Globals as any).getMasterVolume?.() ?? 1); } catch { return 1; }
  });
  const [music,  setMusic]  = useState(() => getBoolPref('sound.music', true));
  const [sfx,    setSfx]    = useState(() => getBoolPref('sound.sfx',   true));

  function applyVolume(v: number) {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    try { (Globals as any).setMasterVolume?.(clamped); } catch { /* ignore */ }
  }

  function bindBool(key: string, set: (v: boolean) => void) {
    return (v: boolean) => { set(v); setBoolPref(key, v); };
  }

  const pct = Math.round(volume * 100);

  return (
    <SubScreenShell onBack={onBack} title="Sound">
      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>MASTER VOLUME</text>
      <Card>
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16 }}>
          <view style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <text style={{ fontSize: 14, color: C.text, flex: 1 }}>{pct}%</text>
            <button onClick={() => applyVolume(0)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0 }}>
              <text style={{ fontSize: 12, color: C.secondary }}>Mute</text>
            </button>
          </view>
          <view style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
            <view style={{ width: `${pct}%`, height: '100%', backgroundColor: C.green }} />
          </view>
          <view style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <button onClick={() => applyVolume(volume - 0.1)} style={{
              flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 0,
              borderRadius: 10, paddingTop: 10, paddingBottom: 10, alignItems: 'center', justifyContent: 'center',
            }}>
              <icon set="material-rounded" style={{ fontSize: 20, color: C.text, lineHeight: 20 }}>remove</icon>
            </button>
            <button onClick={() => applyVolume(volume + 0.1)} style={{
              flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 0,
              borderRadius: 10, paddingTop: 10, paddingBottom: 10, alignItems: 'center', justifyContent: 'center',
            }}>
              <icon set="material-rounded" style={{ fontSize: 20, color: C.text, lineHeight: 20 }}>add</icon>
            </button>
          </view>
        </view>
      </Card>

      <Card>
        <ToggleRow label="Music"             sublabel="Background music in menus and games" value={music} onChange={bindBool('sound.music', setMusic)} />
        <Divider />
        <ToggleRow label="Sound effects"     sublabel="UI taps and gameplay SFX"            value={sfx}   onChange={bindBool('sound.sfx',   setSfx)} />
      </Card>
    </SubScreenShell>
  );
}

// ── Help & Support ───────────────────────────────────────────────────────────

function HelpScreen({ onBack }: { onBack: () => void }) {
  return (
    <SubScreenShell onBack={onBack} title="Help & Support">
      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>GET IN TOUCH</text>
      <Card>
        <InfoRow label="Support email" value="support@pludo.gg" />
        <Divider />
        <InfoRow label="Status"        value="All systems normal" />
      </Card>

      <text style={{ fontSize: 12, color: C.secondary, marginBottom: 8, marginLeft: 4 }}>FREQUENTLY ASKED</text>
      <Card>
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
          <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold', marginBottom: 4 }}>How do I create a game?</text>
          <text style={{ fontSize: 13, color: C.secondary, lineHeight: 18 }}>
            Open the Create tab and describe what you want to build. Pludo's AI will scaffold the world and gameplay.
          </text>
        </view>
        <Divider />
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
          <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold', marginBottom: 4 }}>How do I invite friends?</text>
          <text style={{ fontSize: 13, color: C.secondary, lineHeight: 18 }}>
            Use the Chat tab to search by username and send a friend request.
          </text>
        </view>
        <Divider />
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }}>
          <text style={{ fontSize: 14, color: C.text, fontWeight: 'bold', marginBottom: 4 }}>I found a bug — what do I do?</text>
          <text style={{ fontSize: 13, color: C.secondary, lineHeight: 18 }}>
            Email support@pludo.gg with a description and (if possible) a screenshot or video clip.
          </text>
        </view>
      </Card>
    </SubScreenShell>
  );
}

// ── About ────────────────────────────────────────────────────────────────────

function AboutScreen({ onBack }: { onBack: () => void }) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    try { setVersion(String((Globals as any).getAppVersion?.() ?? '')); } catch { /* ignore */ }
  }, []);

  return (
    <SubScreenShell onBack={onBack} title="About">
      <Card>
        <InfoRow label="App"     value="Pludo" />
        <Divider />
        <InfoRow label="Version" value={version || '—'} />
        <Divider />
        <InfoRow label="Build"   value={(Globals as any)?.platform ? String((Globals as any).platform) : 'Mobile'} />
      </Card>

      <Card>
        <view style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16 }}>
          <text style={{ fontSize: 13, color: C.secondary, lineHeight: 19 }}>
            Pludo lets anyone build, share, and play multiplayer games with AI as a co-creator.
            Thanks for being part of the alpha — your feedback shapes what we ship next.
          </text>
        </view>
      </Card>

      <text style={{ fontSize: 11, color: C.secondary, textAlign: 'center', marginBottom: 24 }}>
        © 2026 Pludo. All rights reserved.
      </text>
    </SubScreenShell>
  );
}

// ── Top-level Settings index ────────────────────────────────────────────────

interface Props {
  onNavigate: (section: number) => void;
  onLogout: () => void;
}

const ROWS: Array<{ key: SubScreen; label: string; icon: string }> = [
  { key: 'account',       label: 'Account',        icon: 'account_circle' },
  { key: 'notifications', label: 'Notifications',  icon: 'notifications'  },
  { key: 'privacy',       label: 'Privacy',        icon: 'lock'           },
  { key: 'display',       label: 'Display',        icon: 'palette'        },
  { key: 'sound',         label: 'Sound',          icon: 'volume_up'      },
  { key: 'help',          label: 'Help & Support', icon: 'help'           },
  { key: 'about',         label: 'About',          icon: 'info'           },
];

export function SettingsScreen({ onNavigate, onLogout }: Props) {
  const [sub, setSub] = useState<SubScreen>('index');

  if (sub !== 'index') {
    const back = () => setSub('index');
    switch (sub) {
      case 'account':       return <AccountScreen       onBack={back} />;
      case 'notifications': return <NotificationsScreen onBack={back} />;
      case 'privacy':       return <PrivacyScreen       onBack={back} />;
      case 'display':       return <DisplayScreen       onBack={back} />;
      case 'sound':         return <SoundScreen         onBack={back} />;
      case 'help':          return <HelpScreen          onBack={back} />;
      case 'about':         return <AboutScreen         onBack={back} />;
    }
  }

  return (
    <view style={{ flex: 1, backgroundColor: C.bg, flexDirection: 'column' }}>
      <view style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', flexDirection: 'column' }}>

      <view style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 20, paddingTop: safeAreaTop() + 4, paddingBottom: 12, gap: 12 }}>
        <button onClick={() => onNavigate(0)} style={{ backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0, padding: 4 }}>
          <icon set="material-rounded" style={{ fontSize: 24, color: C.green, lineHeight: 24 }}>arrow_back</icon>
        </button>
        <text style={{ fontSize: 24, color: C.text, fontWeight: 'bold', flex: 1 }}>Settings</text>
      </view>

      <scroll className="pludo-scroll" style={{ flex: 1, height: 1, paddingLeft: 16, paddingRight: 16, paddingTop: 8 }}>

        <view style={{ backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden', marginBottom: 24 }}>
          {ROWS.map((s, i) => (
            <view key={s.key}>
              <button onClick={() => setSub(s.key)} style={{
                paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16,
                backgroundColor: 'rgba(0,0,0,0.002)', borderWidth: 0,
              }}>
                <view style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <view style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <icon set="material-rounded" style={{ fontSize: 20, color: C.text, lineHeight: 20 }}>{s.icon}</icon>
                  </view>
                  <text style={{ fontSize: 16, color: C.text, flex: 1 }}>{s.label}</text>
                  <icon set="material-rounded" style={{ fontSize: 20, color: C.secondary, lineHeight: 20 }}>chevron_right</icon>
                </view>
              </button>
              {i < ROWS.length - 1 && (
                <view style={{ height: 1, backgroundColor: C.border, marginLeft: 66 }} />
              )}
            </view>
          ))}
        </view>

        <button onClick={onLogout} style={{
          backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border,
          paddingTop: 16, paddingBottom: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 24,
        }}>
          <text style={{ fontSize: 16, color: C.red, fontWeight: 'bold' }}>Sign Out</text>
        </button>

      </scroll>
      </view>
    </view>
  );
}
