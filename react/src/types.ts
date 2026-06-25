export interface GameData {
  id: number;
  title: string;
  description?: string;
  genre?: string;
  creatorName?: string;
  plays: number;
  likes?: number;
  isHot: boolean;
  tags?: string[];
  thumbnailUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AvatarItemData {
  id?: number;
  name: string;
  category: string;
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  price: number;
  equipped?: boolean;
  description?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  modelUrl?: string;
  creatorName?: string;
}

// A cached Meshy 3D model from Cloudflare R2 — surfaced by the Assets picker
// (formerly the Asset Shop). modelUrl is the public CDN URL of the GLB file.
// thumbnailUrl is a pre-rendered PNG preview (server-side puppeteer backfill);
// title is a human-readable label used for search and grid display.
export interface AssetItem {
  cacheKey:     string;
  prompt:       string;
  isHumanoid:   boolean;
  sizeHint:     number;   // real-world longest dimension in meters (height for humanoids)
  modelUrl:     string;
  thumbnailUrl?: string;
  title?:        string;
}

export interface UserResult {
  id: string;
  username: string;
  handle: string;
}

export interface FriendData {
  id: string;
  name: string;
  handle?: string;
  status: 'playing' | 'online' | 'building' | 'offline';
}

export interface ChatMessage {
  id: string;
  from: 'me' | 'them';
  text: string;
  ts: number;
}
