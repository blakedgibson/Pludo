import React, { useEffect, useRef, useState } from 'react';
import { C } from '../theme';
import { CONTENT_MAX_WIDTH } from '../responsive';
import { GameData } from '../types';
import { safeAreaTop, safeAreaBottom } from '../safeArea';
import { Pressable } from '../components/Pressable';
import {
  fetchGameSocial, toggleGameLike, postGameComment, recordGamePlay,
  formatCount, formatTimeAgo,
  GameComment,
} from '../api';

// Material Symbols Rounded glyph names by genre — rendered through ReactUnity's
// <icon set="material-rounded"> element (same mechanism as the bottom nav).
const GENRE_ICON: Record<string, string> = {
  platformer: 'directions_run',
  strategy:   'extension',
  survival:   'local_fire_department',
  simulation: 'paid',
  racer:      'directions_car',
  puzzle:     'extension',
  adventure:  'swords',
};

interface Props {
  game: GameData;
  onClose: () => void;
  onPlay: (gameId: number) => void;
}

// Resolve current user info from the auth bridge — used as the display name
// on likes/comments.
function getMyName(): string {
  try { return String((Globals as any).getDisplayName?.() ?? '').trim() || 'You'; }
  catch { return 'You'; }
}

// Industry-standard preview overlay: hero (3D viewport), title block, metadata
// strip, description, comments. Mirrors the structure used by Roblox/itch.io —
// hero up top, actions on the right, scrollable detail below.
export function GamePreviewScreen({ game, onClose, onPlay }: Props) {
  const [social, setSocial] = useState({
    likes: game.likes ?? 0,
    comments: 0,
    plays: game.plays ?? 0,
    likedByMe: false,
    recentComments: [] as GameComment[],
  });
  const [loading,    setLoading]    = useState(true);
  const [commentDraft, setCommentDraft] = useState('');
  const [posting,    setPosting]    = useState(false);
  const [likeBusy,   setLikeBusy]   = useState(false);
  // If the saved thumbnail URL 404s / errors, fall back to the genre emoji so
  // the hero never displays a broken-image placeholder.
  const [thumbBroken, setThumbBroken] = useState(false);
  const previewLoadedRef = useRef(false);

  // Load social data + trigger Unity orbit-preview so the user can look around.
  // Uses loadGameForPreview (NOT loadGameForEdit) so the lobby stays portrait —
  // landscape only kicks in when the user actually presses Play. Same underlying
  // _previewMode=true orbit camera + thumbnail-capture flow as edit mode.
  useEffect(() => {
    let cancelled = false;
    fetchGameSocial(game.id).then(s => { if (!cancelled) { setSocial(s); setLoading(false); } });
    if (!previewLoadedRef.current) {
      previewLoadedRef.current = true;
      try { (Globals as any).loadGameForPreview?.(game.id); } catch {}
    }
    return () => {
      cancelled = true;
      // Tear down the Unity preview when the user closes the page so the world
      // doesn't keep rendering behind the next screen.
      try { (Globals as any).exitGame?.(); } catch {}
    };
  }, [game.id]);

  async function handleToggleLike() {
    if (likeBusy) return;
    setLikeBusy(true);
    // Optimistic update — feels instant; reconcile on server response.
    setSocial(s => ({
      ...s,
      likedByMe: !s.likedByMe,
      likes: s.likes + (s.likedByMe ? -1 : 1),
    }));
    const r = await toggleGameLike(game.id, getMyName());
    if (r) setSocial(s => ({ ...s, likedByMe: r.liked, likes: r.likes } as any));
    setLikeBusy(false);
  }

  async function handlePostComment() {
    const text = commentDraft.trim();
    if (!text || posting) return;
    setPosting(true);
    const c = await postGameComment(game.id, text, getMyName());
    if (c) {
      setSocial(s => ({
        ...s,
        comments: s.comments + 1,
        recentComments: [c, ...s.recentComments],
      }));
      setCommentDraft('');
    }
    setPosting(false);
  }

  function handlePlay() {
    recordGamePlay(game.id);
    setSocial(s => ({ ...s, plays: s.plays + 1 }));
    onPlay(game.id);
  }

  const heroFallback = GENRE_ICON[game.genre ?? ''] ?? 'sports_esports';

  return (
    <view style={{
      // Fills the full screen — App.tsx hides the BottomNav while a preview
      // is open, so the Play bar at the bottom of this overlay lands at the
      // actual bottom of the screen (above the iOS home-indicator inset,
      // which the Play bar pads for separately).
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      // Root is fully transparent so the Unity orbit-preview behind us shows
      // through the hero region. The info panel below paints its own C.bg.
      backgroundColor: 'rgba(0,0,0,0)',
      flexDirection: 'column',
    }}>
      <scroll className="pludo-scroll" style={{ flex: 1, height: 1 }}>

        {/* ── Hero: thumbnail image fills the region; emoji fallback when none ── */}
        {/* The Unity orbit-preview still loads in the background (loadGameForEdit
            in the effect above) so the +3s/+8s thumbnail capture still fires for
            games without a saved thumbnail — but the visible hero is the static
            thumbnail. */}
        <view style={{
          position: 'relative',
          width: '100%',
          height: 360,
          backgroundColor: C.card,
          overflow: 'hidden',
        }}>
          {game.thumbnailUrl && !thumbBroken ? (
            <image
              src={game.thumbnailUrl}
              onError={() => setThumbBroken(true)}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, objectFit: 'cover' } as any}
            />
          ) : (
            <view style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <icon set="material-rounded" style={{ fontSize: 96, color: 'rgba(255,255,255,0.4)', lineHeight: 96 }}>{heroFallback}</icon>
            </view>
          )}

          {/* Bottom-edge gradient so the title block reads cleanly against any
              thumbnail. */}
          <view style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 80,
            backgroundColor: 'rgba(0,0,0,0.35)',
          }} />
        </view>

        {/* ── Info panel — opaque background starts here ──────────────────── */}
        {/* Constrained/centered on tablet so metadata/description/comments
            don't read as one unbroken full-width column on iPad. */}
        <view style={{ backgroundColor: C.bg, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>

          {/* Title block (no play button — it's now in the bottom action bar) */}
          <view style={{ paddingLeft: 20, paddingRight: 20, paddingTop: 18, paddingBottom: 4 }}>
            <text style={{ fontSize: 26, color: C.text, fontWeight: 'bold', letterSpacing: -0.4 }}>
              {game.title}
            </text>
            <text style={{ fontSize: 14, color: C.secondary, marginTop: 4 }}>
              by {game.creatorName ?? 'unknown'} · {formatTimeAgo(game.createdAt)}
            </text>
          </view>

        {/* ── Metadata strip: genre, plays, comments, like button ─────────── */}
        <view style={{
          flexDirection: 'row', flexWrap: 'wrap', gap: 8,
          paddingLeft: 20, paddingRight: 20, paddingTop: 14, paddingBottom: 14,
          alignItems: 'center',
        }}>
          {game.genre ? <Pill icon={GENRE_ICON[game.genre] ?? 'sports_esports'} label={cap(game.genre)} /> : null}
          <Pill icon="play_arrow" label={`${formatCount(social.plays)} plays`} />
          <Pill icon="chat_bubble" label={`${formatCount(social.comments)}`} />
          <view style={{ flex: 1 }} />
          <Pressable
            onClick={handleToggleLike}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              backgroundColor: social.likedByMe ? 'rgba(255,69,58,0.15)' : C.card,
              borderRadius: 18, borderWidth: 1,
              borderColor: social.likedByMe ? '#ff453a' : C.border,
              paddingLeft: 12, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
            }}
          >
            <icon set={social.likedByMe ? 'material-rounded-filled' : 'material-rounded'} style={{ fontSize: 16, color: social.likedByMe ? '#ff453a' : C.text, lineHeight: 16 }}>favorite</icon>
            <text style={{ fontSize: 13, color: social.likedByMe ? '#ff453a' : C.text, fontWeight: 'bold' }}>
              {formatCount(social.likes)}
            </text>
          </Pressable>
        </view>

        {/* ── Description ─────────────────────────────────────────────────── */}
        {game.description ? (
          <view style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 16 }}>
            <SectionTitle>About</SectionTitle>
            <text style={{ fontSize: 14, color: C.text, lineHeight: 21 }}>
              {game.description}
            </text>
          </view>
        ) : null}

        {/* ── Tags ────────────────────────────────────────────────────────── */}
        {game.tags && game.tags.length > 0 ? (
          <view style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 16 }}>
            <view style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {game.tags.map(t => (
                <view key={t} style={{
                  backgroundColor: C.surface, borderRadius: 10,
                  borderWidth: 1, borderColor: C.border,
                  paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4,
                }}>
                  <text style={{ fontSize: 12, color: C.secondary }}>#{t}</text>
                </view>
              ))}
            </view>
          </view>
        ) : null}

        {/* ── Timeline ────────────────────────────────────────────────────── */}
        <view style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 16 }}>
          <SectionTitle>Timeline</SectionTitle>
          <view style={{ gap: 6 }}>
            <TimelineRow label="Created"      value={formatTimeAgo(game.createdAt)} />
            <TimelineRow label="Last updated" value={formatTimeAgo(game.updatedAt ?? game.createdAt)} />
          </view>
        </view>

        {/* ── Comments ────────────────────────────────────────────────────── */}
        <view style={{ paddingLeft: 20, paddingRight: 20, paddingBottom: 32 }}>
          <SectionTitle>Comments {social.comments > 0 ? `(${social.comments})` : ''}</SectionTitle>

          <view style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: C.card, borderRadius: 14,
            borderWidth: 1, borderColor: C.border,
            paddingLeft: 14, paddingRight: 6, paddingTop: 6, paddingBottom: 6,
            marginBottom: 14,
          }}>
            <input
              value={commentDraft}
              onChange={(e: any) => setCommentDraft(String(e?.target?.value ?? e?.value ?? ''))}
              placeholder="Leave a comment…"
              style={{
                flex: 1, fontSize: 14, color: C.text, backgroundColor: 'transparent',
                borderWidth: 0, paddingTop: 8, paddingBottom: 8,
              } as any}
            />
            <button
              onClick={handlePostComment}
              style={{
                backgroundColor: commentDraft.trim() ? C.green : C.surface,
                borderRadius: 10, borderWidth: 0,
                paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
              }}
            >
              <text style={{
                fontSize: 13,
                color: commentDraft.trim() ? C.bg : C.secondary,
                fontWeight: 'bold',
              }}>
                {posting ? '...' : 'Post'}
              </text>
            </button>
          </view>

          {loading ? (
            <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center', paddingTop: 8 }}>Loading…</text>
          ) : social.recentComments.length === 0 ? (
            <text style={{ fontSize: 13, color: C.secondary, textAlign: 'center', paddingTop: 8 }}>
              No comments yet — be the first.
            </text>
          ) : (
            <view style={{ gap: 10 }}>
              {social.recentComments.map(c => <CommentRow key={c.id} comment={c} />)}
            </view>
          )}
        </view>

        {/* Bottom spacer so the sticky Play bar never covers the last comment.
            Sized to clear the Play-bar height (~76 px button + 24 px padding)
            plus the iOS home-indicator inset the bar pads for. */}
        <view style={{ height: safeAreaBottom() + 110, backgroundColor: C.bg }} />

        </view> {/* end info panel */}

      </scroll>

      {/* ── Persistent close button — top-left, always reachable ──────────── */}
      <button onClick={onClose} style={{
        position: 'absolute', top: safeAreaTop() + 10, left: 12,
        width: 36, height: 36, borderRadius: 18,
        backgroundColor: 'rgba(0,0,0,0.55)',
        borderWidth: 0, alignItems: 'center', justifyContent: 'center',
      }}>
        <icon set="material-rounded" style={{ fontSize: 22, color: '#fff', lineHeight: 22 }}>close</icon>
      </button>

      {/* ── Sticky bottom Play bar — full-width primary action ─────────────
          BottomNav is hidden while a preview is open, so this bar sits at the
          actual bottom of the screen. paddingBottom adds the iOS home-indicator
          inset so the button stays clear of the bezel on notch iPhones. */}
      <view style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        paddingLeft: 16, paddingRight: 16,
        paddingTop: 12, paddingBottom: 12 + safeAreaBottom(),
        backgroundColor: C.bg,
        borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)',
      }}>
        <button onClick={handlePlay} style={{
          width: '100%',
          backgroundColor: C.green, borderRadius: 16, borderWidth: 0,
          paddingTop: 16, paddingBottom: 16,
          alignItems: 'center', justifyContent: 'center',
          flexDirection: 'row', gap: 6,
        }}>
          <icon set="material-rounded-filled" style={{ fontSize: 20, color: C.bg, lineHeight: 20 }}>play_arrow</icon>
          <text style={{ fontSize: 17, color: C.bg, fontWeight: 'bold' }}>Play</text>
        </button>
      </view>
    </view>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <text style={{ fontSize: 13, color: C.secondary, fontWeight: 'bold', marginBottom: 8, letterSpacing: 0.5 }}>
      {String(children).toUpperCase()}
    </text>
  );
}

function Pill({ icon, label }: { icon: string; label: string }) {
  return (
    <view style={{
      flexDirection: 'row', alignItems: 'center', gap: 5,
      backgroundColor: C.card, borderRadius: 18,
      borderWidth: 1, borderColor: C.border,
      paddingLeft: 12, paddingRight: 14, paddingTop: 7, paddingBottom: 7,
    }}>
      <icon set="material-rounded" style={{ fontSize: 15, color: C.text, lineHeight: 15 }}>{icon}</icon>
      <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>{label}</text>
    </view>
  );
}

function TimelineRow({ label, value }: { label: string; value: string }) {
  return (
    <view style={{
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingTop: 6, paddingBottom: 6,
    }}>
      <text style={{ fontSize: 13, color: C.secondary }}>{label}</text>
      <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>{value}</text>
    </view>
  );
}

function CommentRow({ comment }: { comment: GameComment }) {
  return (
    <view style={{
      backgroundColor: C.card, borderRadius: 12,
      borderWidth: 1, borderColor: C.border,
      paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
    }}>
      <view style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <text style={{ fontSize: 13, color: C.text, fontWeight: 'bold' }}>{comment.userName}</text>
        <text style={{ fontSize: 11, color: C.secondary }}>{formatTimeAgo(comment.createdAt)}</text>
      </view>
      <text style={{ fontSize: 14, color: C.text, lineHeight: 19 }}>{comment.body}</text>
    </view>
  );
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
