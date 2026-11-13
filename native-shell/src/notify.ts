import * as SecureStore from 'expo-secure-store';

// "Notify" is per-device for now: there's no notifications backend or push
// setup yet, so the choice is remembered locally until one exists.
const KEY = 'pludo.notifyGames';

async function load(): Promise<number[]> {
  try { return JSON.parse((await SecureStore.getItemAsync(KEY)) ?? '[]'); } catch { return []; }
}

export async function isNotifying(id: number): Promise<boolean> {
  return (await load()).includes(id);
}

export async function setNotifying(id: number, on: boolean): Promise<void> {
  const ids = new Set(await load());
  if (on) ids.add(id); else ids.delete(id);
  await SecureStore.setItemAsync(KEY, JSON.stringify([...ids]));
}
