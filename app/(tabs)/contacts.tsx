import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Contacts from 'expo-contacts';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { toE164 } from '@/utils/phoneNumber';
import { syncCircle } from '@/utils/serverUrl';
import { confirmDestructive } from '@/utils/confirm';
import { Beacon, AVATAR_COLORS, initials } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';

const STORAGE_KEY = '@makeithome_safety_circle';

interface SafetyContact {
  id: string;
  name: string;
  phone: string;
}

// One sheet, two modes — no stacked RN Modals.
type SheetMode = 'closed' | 'form' | 'action';

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function CircleScreen() {
  const router = useRouter();
  const [circle, setCircle] = useState<SafetyContact[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [mode, setMode] = useState<SheetMode>('closed');
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [actionFor, setActionFor] = useState<SafetyContact | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      setCircle(raw ? JSON.parse(raw) : []);
      setLoaded(true);
    });
  }, []);

  // Persist after initial load (so we don't clobber storage with []), and push
  // the circle to the server so alerts can only ever go to these numbers.
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(circle));
    syncCircle(circle.map(c => c.phone).filter(Boolean));
  }, [circle, loaded]);

  // Re-read on focus (escalation reorder, or data deleted from Settings). Reset
  // to [] when storage is empty so deleted contacts don't linger in memory.
  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem(STORAGE_KEY).then(raw => {
        setCircle(raw ? JSON.parse(raw) : []);
      });
    }, []),
  );

  const closeSheet = () => setMode('closed');

  const openAdd = () => {
    setEditId(null);
    setName('');
    setPhone('');
    setMode('form');
  };

  const openActions = (c: SafetyContact) => {
    setActionFor(c);
    setMode('action');
  };

  const editFromAction = () => {
    if (!actionFor) return;
    setEditId(actionFor.id);
    setName(actionFor.name);
    setPhone(actionFor.phone);
    setMode('form');
  };

  const saveContact = () => {
    const n = name.trim();
    const rawP = phone.trim();
    if (!n || !rawP) return;
    const e164 = toE164(rawP);
    if (!e164) {
      Alert.alert(
        'Check the phone number',
        `"${rawP}" isn't a dialable number. Include the full number with country code, e.g. +1 555 123 4567.`,
      );
      return;
    }
    if (editId) {
      setCircle(prev => prev.map(c => (c.id === editId ? { ...c, name: n, phone: e164 } : c)));
    } else {
      setCircle(prev => [...prev, { id: String(Date.now()), name: n, phone: e164 }]);
    }
    closeSheet();
  };

  const removeFromAction = () => {
    const id = actionFor?.id;
    if (!id) return;
    confirmDestructive(
      'Remove from circle',
      'This person will no longer be alerted when you signal.',
      'Remove',
      () => {
        setCircle(prev => prev.filter(c => c.id !== id));
        closeSheet();
      },
    );
  };

  // Opens the OS's native contact picker (like other apps). No custom list and
  // no full contacts-permission prompt needed — the user picks one contact.
  const pickFromContacts = async () => {
    try {
      const contact = await Contacts.presentContactPickerAsync();
      if (!contact) return; // cancelled
      const raw = contact.phoneNumbers?.[0]?.number ?? '';
      const e164 = toE164(raw);
      if (!e164) {
        Alert.alert(
          'No usable number',
          `${contact.name ?? 'That contact'} doesn't have a number we can use — pick another, or type it in above.`,
        );
        return;
      }
      setName(contact.name ?? 'Unknown');
      setPhone(e164);
    } catch {
      Alert.alert('Couldn’t open contacts', 'Try again, or just type the number in above.');
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.head}>
        <Text style={styles.h1}>Safety circle</Text>
        <Text style={styles.sub}>These people are alerted with your location when you signal.</Text>
      </View>

      {circle.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="people-outline" size={44} color={Beacon.faint} />
          <Text style={styles.emptyText}>No one yet — add the people who&apos;d come for you.</Text>
        </View>
      ) : (
        <FlatList
          data={circle}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingHorizontal: 20 }}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              onPress={() => openActions(item)}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(item.name) }]}>
                <Text style={styles.avatarText}>{initials(item.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowPhone}>{item.phone}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}

      <View style={styles.footer}>
        <PillButton
          title="⚡  Escalation ladder"
          kind="ghost"
          onPress={() => router.push('/escalation')}
        />
        <Pressable style={styles.addRow} onPress={openAdd}>
          <Text style={styles.addText}>＋ Add someone</Text>
        </Pressable>
      </View>

      {/* One modal, form/action modes. The inner GestureHandlerRootView is
          required — a RN Modal renders outside the app's root one, and without
          it taps inside the modal don't register once gesture-handler is used. */}
      <Modal
        visible={mode !== 'closed'}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            <Pressable style={styles.scrim} onPress={closeSheet} />
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.kav}>
              <View style={styles.sheet}>
                {mode === 'action' ? (
                  <>
                    <Text style={styles.sheetTitle}>{actionFor?.name}</Text>
                    <Text style={styles.sheetSub}>{actionFor?.phone}</Text>
                    <View style={styles.sheetBtns}>
                      <PillButton title="Edit" kind="dark" onPress={editFromAction} style={{ flex: 1 }} />
                      <PillButton
                        title="Remove"
                        kind="dark"
                        onPress={removeFromAction}
                        style={{ flex: 1 }}
                        textStyle={{ color: '#ff8a6e' }}
                      />
                    </View>
                    <PillButton title="Cancel" kind="ghost" onPress={closeSheet} style={{ marginTop: 10 }} />
                  </>
                ) : (
                  <>
                    <Text style={styles.sheetTitle}>{editId ? 'Edit contact' : 'Add someone'}</Text>
                    <Text style={styles.sheetSub}>
                      They&apos;ll be alerted with your location when you signal.
                    </Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Name"
                      placeholderTextColor={Beacon.faint}
                      value={name}
                      onChangeText={setName}
                      autoCapitalize="words"
                    />
                    <TextInput
                      style={styles.input}
                      placeholder="Phone number"
                      placeholderTextColor={Beacon.faint}
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                    />
                    {!editId && (
                      <Pressable onPress={pickFromContacts} style={styles.pickLink}>
                        <Ionicons name="person-add-outline" size={15} color={Beacon.info} />
                        <Text style={styles.pickLinkText}>Choose from my contacts</Text>
                      </Pressable>
                    )}
                    <Text style={styles.consent}>
                      By adding someone, you confirm they&apos;ve agreed to receive emergency safety
                      texts from you. Message &amp; data rates may apply. Reply STOP to opt out.
                    </Text>
                    <View style={styles.sheetBtns}>
                      <PillButton title="Cancel" kind="dark" onPress={closeSheet} style={{ flex: 1 }} />
                      <PillButton
                        title={editId ? 'Save' : 'Add'}
                        kind="primary"
                        onPress={saveContact}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </>
                )}
              </View>
            </KeyboardAvoidingView>
          </View>
        </GestureHandlerRootView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  head: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 },
  h1: { fontSize: 22, fontWeight: '800', color: Beacon.text, letterSpacing: -0.3 },
  sub: { fontSize: 12.5, color: Beacon.muted, marginTop: 4 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40 },
  emptyText: { color: Beacon.muted, fontSize: 13.5, textAlign: 'center', lineHeight: 19 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  rowName: { fontSize: 14, fontWeight: '700', color: Beacon.text },
  rowPhone: { fontSize: 11.5, color: Beacon.muted, marginTop: 1 },
  chevron: { color: Beacon.faint, fontSize: 20 },

  footer: { paddingHorizontal: 20, paddingBottom: 16, paddingTop: 10, gap: 10 },
  addRow: {
    borderWidth: 1,
    borderColor: '#4a3a34',
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  addText: { color: Beacon.beacon, fontWeight: '700', fontSize: 13.5 },

  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(4,7,12,0.6)' },
  kav: { marginTop: 'auto' },
  sheet: {
    backgroundColor: Beacon.surface,
    borderTopWidth: 1,
    borderTopColor: Beacon.line,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 34,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: Beacon.text, marginBottom: 4 },
  sheetSub: { fontSize: 12, color: Beacon.muted, marginBottom: 14 },
  input: {
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: Beacon.text,
    fontSize: 15,
    marginBottom: 10,
  },
  pickLink: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 6 },
  pickLinkText: { color: Beacon.info, fontWeight: '600', fontSize: 13 },
  consent: { color: Beacon.faint, fontSize: 11, lineHeight: 15, marginBottom: 10 },
  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
});
