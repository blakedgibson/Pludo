import React from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '../auth';
import { UnityHost } from '../unity/UnityHost';

// Root: providers + the single Unity view (UnityHost renders it above every
// screen), then a stack so pages like the avatar customizer can cover the tabs.
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <StatusBar style="light" />
          <UnityHost>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000' } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="avatar" options={{ animation: 'slide_from_bottom', gestureEnabled: true }} />
              <Stack.Screen name="notifications" />
              {/* Game drawer: native sheet; transparent so iOS 26 draws it as Liquid Glass. */}
              <Stack.Screen
                name="game/[id]"
                options={{
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.7, 1.0],
                  sheetGrabberVisible: true,
                  sheetCornerRadius: 32,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              {/* "Create 3D Model": same Liquid Glass sheet treatment. */}
              <Stack.Screen
                name="forge"
                options={{
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.6, 1.0],
                  sheetGrabberVisible: true,
                  sheetCornerRadius: 32,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
            </Stack>
          </UnityHost>
        </View>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
