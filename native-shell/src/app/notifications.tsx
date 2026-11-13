import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { HeaderButton } from '../components/HeaderButton';

// Opened from the bell on the Home tab. There's no notifications backend yet,
// so this is the empty state until one exists.
export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View style={[styles.page, { paddingTop: insets.top + 4 }]}>
      <View style={styles.headerRow}>
        <HeaderButton sf="chevron.left" label="Back" onPress={() => router.back()} />
        <Text style={styles.title}>Notifications</Text>
        <View style={{ width: 44 }} />
      </View>
      <View style={styles.empty}>
        <SymbolView name="bell.slash" size={44} tintColor="#636366" />
        <Text style={styles.emptyTitle}>No notifications yet</Text>
        <Text style={styles.emptySub}>Friend requests, likes and comments on your games will show up here.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#000' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40, paddingBottom: 80 },
  emptyTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  emptySub: { color: '#8E8E93', fontSize: 15, textAlign: 'center' },
});
