import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Beacon } from '@/constants/beacon';
import { TERMS, PRIVACY } from '@/constants/legal';

export default function LegalScreen() {
  const router = useRouter();
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  const isPrivacy = doc === 'privacy';

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>{isPrivacy ? 'Privacy Policy' : 'Terms of Service'}</Text>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.text}>{isPrivacy ? PRIVACY : TERMS}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  title: { fontSize: 16, fontWeight: '800', color: Beacon.text },
  done: { color: Beacon.beacon, fontWeight: '700', fontSize: 15 },
  body: { padding: 20 },
  text: { color: '#cbd3df', fontSize: 13, lineHeight: 22 },
});
