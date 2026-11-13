import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { GlassView } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { forgeStatus, startModelForge, type ForgedItem } from '../api';
import { useAuth } from '../auth';

const STEPS = [
  'Conceptualizing design…',
  'Selecting materials…',
  'Detailing the shape…',
  'Sculpting 3D model…',
  'Applying textures…',
  'Finishing touches…',
];

type Phase =
  | { kind: 'prompt'; error?: string }
  | { kind: 'forging'; jobId: string; modeling: boolean }
  | { kind: 'done'; item: ForgedItem };

// "Create 3D Model" (from the + menu): describe a model, the AI forge builds
// it (the same /ai/generate-avatar-item pipeline ReactUnity's Forge Asset
// screen uses), and the finished model lands in the shared library — it then
// shows up in the editor's asset library for any game.
export default function ForgeScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'prompt' });
  const [step, setStep] = useState(0);

  // Poll the job; tick the friendly step label while waiting.
  const jobId = phase.kind === 'forging' ? phase.jobId : null;
  useEffect(() => {
    if (!jobId) return;
    const tick = setInterval(() => setStep(i => Math.min(i + 1, STEPS.length - 1)), 2400);
    const poll = setInterval(async () => {
      try {
        const s = await forgeStatus(jobId);
        if (s.status === 'done') setPhase({ kind: 'done', item: s.item });
        else if (s.status === 'error') setPhase({ kind: 'prompt', error: s.error });
        else if (s.status === 'modeling') setPhase(p => (p.kind === 'forging' && !p.modeling ? { ...p, modeling: true } : p));
      } catch { /* keep polling */ }
    }, 2500);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [jobId]);

  async function forge() {
    const p = prompt.trim();
    if (!p) return;
    try {
      const id = await startModelForge(p, session?.username ?? 'Player');
      setStep(0);
      setPhase({ kind: 'forging', jobId: id, modeling: false });
    } catch (e: any) {
      setPhase({ kind: 'prompt', error: String(e?.message ?? e) });
    }
  }

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>Create 3D Model</Text>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
          <GlassView style={styles.round} glassEffectStyle="regular" isInteractive>
            <SymbolView name="xmark" size={14} weight="semibold" tintColor="#fff" />
          </GlassView>
        </Pressable>
      </View>

      {phase.kind === 'prompt' && (
        <>
          <Text style={styles.sub}>Describe the model you want. It&apos;ll be added to the model library when it&apos;s ready.</Text>
          <GlassView style={styles.inputWrap} glassEffectStyle="regular">
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="e.g. a wooden treasure chest with gold trim"
              placeholderTextColor="rgba(235,235,245,0.45)"
              style={styles.input}
              multiline
              maxLength={300}
              autoFocus
              keyboardAppearance="dark"
            />
          </GlassView>
          {phase.error ? <Text style={styles.error}>{phase.error}</Text> : null}
          <Pressable onPress={forge} disabled={!prompt.trim()} accessibilityRole="button">
            <View style={[styles.primary, !prompt.trim() && styles.primaryOff]}>
              <SymbolView name="cube.fill" size={16} tintColor="#fff" />
              <Text style={styles.primaryText}>Create Model</Text>
            </View>
          </Pressable>
        </>
      )}

      {phase.kind === 'forging' && (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" size="large" />
          <Text style={styles.forgingTitle}>Creating your model</Text>
          <Text style={styles.sub}>{phase.modeling ? 'Crafting 3D model…' : STEPS[step]}</Text>
          <Text style={styles.hint}>This can take a minute or two. You can close this — it keeps going.</Text>
        </View>
      )}

      {phase.kind === 'done' && (
        <View style={styles.center}>
          {phase.item.thumbnailUrl || phase.item.imageUrl ? (
            <Image source={{ uri: phase.item.thumbnailUrl || phase.item.imageUrl }} style={styles.preview} contentFit="contain" />
          ) : (
            <SymbolView name="cube.fill" size={64} tintColor="#fff" />
          )}
          <Text style={styles.forgingTitle}>{phase.item.name || 'Your model'} is ready</Text>
          <Text style={styles.sub}>Find it in the editor&apos;s model library (the + button).</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button">
            <View style={styles.primary}><Text style={styles.primaryText}>Done</Text></View>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 20, paddingTop: 24, gap: 14, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: '#fff', fontSize: 22, fontWeight: '800' },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sub: { color: 'rgba(235,235,245,0.7)', fontSize: 15, textAlign: 'left' },
  inputWrap: { borderRadius: 20, padding: 14, minHeight: 110 },
  input: { color: '#fff', fontSize: 16, minHeight: 80, textAlignVertical: 'top' },
  error: { color: '#FF453A', fontSize: 14 },
  primary: {
    height: 50, borderRadius: 25, backgroundColor: '#0A84FF',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  primaryOff: { backgroundColor: 'rgba(10,132,255,0.35)' },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 40 },
  forgingTitle: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  hint: { color: 'rgba(235,235,245,0.45)', fontSize: 13, textAlign: 'center' },
  preview: { width: 160, height: 160 },
});
