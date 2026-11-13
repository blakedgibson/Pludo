import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView } from 'expo-glass-effect';
import { useAuth } from '../auth';

// Shown on the You tab when signed out. Same account as the Unity app:
// username or email + password.
export function SignIn() {
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = id.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try { await signIn(id, password); }
    catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.page, { paddingTop: insets.top + 60 }]}>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.sub}>Use your Pludo account to see your profile and games.</Text>

      <GlassView style={styles.field} glassEffectStyle="regular">
        <TextInput
          value={id}
          onChangeText={setId}
          placeholder="Username or email"
          placeholderTextColor="rgba(255,255,255,0.45)"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          returnKeyType="next"
          style={styles.input}
        />
      </GlassView>
      <GlassView style={styles.field} glassEffectStyle="regular">
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor="rgba(255,255,255,0.45)"
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
          style={styles.input}
        />
      </GlassView>

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable onPress={submit} disabled={!canSubmit} accessibilityRole="button" style={{ opacity: canSubmit ? 1 : 0.5 }}>
        <GlassView style={styles.button} glassEffectStyle="regular" tintColor="#5B9CFF" isInteractive>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </GlassView>
      </Pressable>
      <View style={{ flex: 1 }} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000', paddingHorizontal: 24, gap: 14 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800' },
  sub: { color: '#8E8E93', fontSize: 15, marginBottom: 12 },
  field: { height: 54, borderRadius: 27, justifyContent: 'center', paddingHorizontal: 20 },
  input: { color: '#fff', fontSize: 17 },
  error: { color: '#FF453A', fontSize: 14 },
  button: { height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
