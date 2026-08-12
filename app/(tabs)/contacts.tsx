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
  Linking,
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

// A single sheet with several modes avoids stacking multiple RN Modals, which
// don't present reliably at the same time (the old bug: opening the contact
// picker on top of the add sheet).
type SheetMode = 'closed' | 'form' | 'action' | 'picker';

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

  const [deviceContacts, setDeviceContacts] = useState<Contacts.Contact[]>([]);
  const [search, setSearch] = useState('');

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

  // Re-read on focus in case the escalation screen reordered the list, or the
  // data was deleted from Settings — reset to [] when storage is empty so
  // deleted contacts don't linger in memory.
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

  // Switches the same sheet from the action view to the edit form — no second modal.
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

  // Loads device contacts and switches THIS sheet to picker mode (not a new modal).
  const openPickerMode = async () => {
    const { status, canAskAgain } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') {
      // Once denied, the OS won't re-prompt — guide the user to Settings.
      if (!canAskAgain) {
        Alert.alert(
          'Contacts access is off',
          'Turn on Contacts for Make It Home in Settings to pick from your phone — or just type the number above.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      } else {
        Alert.alert('Permission needed', 'Allow contacts access to pick from your phone, or type the number above.');
      }
      return;
    }
    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
      });
      const withPhone = data
        .filter(c => c.name && c.phoneNumbers && c.phoneNumbers.length > 0)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      setDeviceContacts(withPhone);
      setSearch('');
      setMode('picker');
    } catch {
      Alert.alert('Couldn’t load contacts', 'Something went wrong reading your contacts — you can type the number above instead.');
    }
  };

  const pickDeviceContact = (contact: Contacts.Contact) => {
    const rawPhone = contact.phoneNumbers?.[0]?.number ?? '';
    const e164 = toE164(rawPhone);
    if (!e164) {
      Alert.alert(
        'Unsupported number',
        `"${rawPhone}" couldn't be converted to a dialable format. Edit it in your Contacts app to include a full number.`,
      );
      return;
    }
    setName(contact.name ?? 'Unknown');
    setPhone(e164);
    setMode('form');
  };

  const filtered = search
    ? deviceContacts.filter(c => c.name?.toLowerCase().includes(search.toLowerCase()))
    : deviceContacts;

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

      {/* One modal, several modes — never two modals at once. The inner
          GestureHandlerRootView is required: a RN Modal renders outside the app's
          root GestureHandlerRootView, and without one here taps inside the modal
          don't register once react-native-gesture-handler is installed. */}
      <Modal
        visible={mode !== 'closed'}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}>
        <GestureHandlerRootView style={{ flex: 1 }}>
        {mode === 'picker' ? (
          <SafeAreaView style={styles.pickerRoot}>
            <View style={styles.pickerHead}>
              <Pressable onPress={() => setMode('form')} hitSlop={8} style={styles.pickerBack}>
                <Ionicons name="chevron-back" size={22} color={Beacon.text} />
              </Pressable>
              <Text style={styles.pickerTitle}>Choose a contact</Text>
              <Pressable onPress={() => setMode('form')} hitSlop={8}>
                <Text style={styles.pickerDone}>Done</Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.searchInput}
              placeholder="Search contacts…"
              placeholderTextColor={Beacon.faint}
              value={search}
              onChangeText={setSearch}
            />
            <FlatList
              data={filtered}
              keyExtractor={(item, index) => (item as any).id ?? `${item.name ?? 'c'}-${index}`}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const nm = item.name ?? 'Unknown';
                const raw = item.phoneNumbers?.[0]?.number ?? '';
                const disp = toE164(raw) ?? raw;
                return (
                  <Pressable style={styles.pickRow} onPress={() => pickDeviceContact(item)}>
                    <View style={[styles.avatar, { backgroundColor: avatarColor(nm) }]}>
                      <Text style={styles.avatarText}>{initials(nm)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{nm}</Text>
                      <Text style={styles.rowPhone}>{disp}</Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          </SafeAreaView>
        ) : (
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
                      <Pressable onPress={openPickerMode} style={styles.pickLink}>
                        <Ionicons name="person-add-outline" size={15} color={Beacon.info} />
                        <Text style={styles.pickLinkText}>Choose from my contacts</Text>
                      </Pressable>
                    )}
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
        )}
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
  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },

  pickerRoot: { flex: 1, backgroundColor: Beacon.night },
  pickerHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  pickerBack: { width: 30 },
  pickerTitle: { fontSize: 17, fontWeight: '800', color: Beacon.text },
  pickerDone: { fontSize: 15, color: Beacon.beacon, fontWeight: '700' },
  searchInput: {
    margin: 16,
    padding: 12,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 10,
    fontSize: 15,
    color: Beacon.text,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
});
