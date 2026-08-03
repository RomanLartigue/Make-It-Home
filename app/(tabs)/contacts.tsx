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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Contacts from 'expo-contacts';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { toE164 } from '@/utils/phoneNumber';
import { confirmDestructive } from '@/utils/confirm';
import { Beacon, AVATAR_COLORS, initials } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';

const STORAGE_KEY = '@makeithome_safety_circle';

interface SafetyContact {
  id: string;
  name: string;
  phone: string;
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function CircleScreen() {
  const router = useRouter();
  const [circle, setCircle] = useState<SafetyContact[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Add / edit sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  // Contact action sheet
  const [actionFor, setActionFor] = useState<SafetyContact | null>(null);

  // Device picker
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deviceContacts, setDeviceContacts] = useState<Contacts.Contact[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) setCircle(JSON.parse(raw));
      setLoaded(true);
    });
  }, []);

  // Persist after initial load (so we don't clobber storage with []).
  useEffect(() => {
    if (loaded) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(circle));
  }, [circle, loaded]);

  // Re-read on focus in case the escalation screen reordered the list.
  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem(STORAGE_KEY).then(raw => {
        if (raw) setCircle(JSON.parse(raw));
      });
    }, []),
  );

  const openAdd = () => {
    setEditId(null);
    setName('');
    setPhone('');
    setSheetOpen(true);
  };

  const openEdit = (c: SafetyContact) => {
    setActionFor(null);
    setEditId(c.id);
    setName(c.name);
    setPhone(c.phone);
    setSheetOpen(true);
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
    setSheetOpen(false);
  };

  const removeContact = (id: string) => {
    setActionFor(null);
    confirmDestructive(
      'Remove from circle',
      'This person will no longer be alerted when you signal.',
      'Remove',
      () => setCircle(prev => prev.filter(c => c.id !== id)),
    );
  };

  const openPicker = async () => {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow contacts access to pick someone from your phone.');
      return;
    }
    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
    });
    const withPhone = data
      .filter(c => c.name && c.phoneNumbers && c.phoneNumbers.length > 0)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    setDeviceContacts(withPhone);
    setSearch('');
    setPickerOpen(true);
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
    const nm = contact.name ?? 'Unknown';
    setPickerOpen(false);
    setName(nm);
    setPhone(e164);
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
              onPress={() => setActionFor(item)}>
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

      {/* Add / edit sheet */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setSheetOpen(false)} />
        <View style={styles.sheet}>
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
            <Pressable onPress={openPicker} style={styles.pickLink}>
              <Ionicons name="person-add-outline" size={15} color={Beacon.info} />
              <Text style={styles.pickLinkText}>Choose from my contacts</Text>
            </Pressable>
          )}
          <View style={styles.sheetBtns}>
            <PillButton title="Cancel" kind="dark" onPress={() => setSheetOpen(false)} style={{ flex: 1 }} />
            <PillButton title={editId ? 'Save' : 'Add'} kind="primary" onPress={saveContact} style={{ flex: 1 }} />
          </View>
        </View>
      </Modal>

      {/* Contact action sheet */}
      <Modal visible={!!actionFor} transparent animationType="slide" onRequestClose={() => setActionFor(null)}>
        <Pressable style={styles.scrim} onPress={() => setActionFor(null)} />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{actionFor?.name}</Text>
          <Text style={styles.sheetSub}>{actionFor?.phone}</Text>
          <View style={styles.sheetBtns}>
            <PillButton
              title="Edit"
              kind="dark"
              onPress={() => actionFor && openEdit(actionFor)}
              style={{ flex: 1 }}
            />
            <PillButton
              title="Remove"
              kind="dark"
              onPress={() => actionFor && removeContact(actionFor.id)}
              style={{ flex: 1 }}
              textStyle={{ color: '#ff8a6e' }}
            />
          </View>
          <PillButton title="Cancel" kind="ghost" onPress={() => setActionFor(null)} style={{ marginTop: 10 }} />
        </View>
      </Modal>

      {/* Device contact picker */}
      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <SafeAreaView style={styles.pickerRoot}>
          <View style={styles.pickerHead}>
            <Text style={styles.pickerTitle}>Choose a contact</Text>
            <Pressable onPress={() => setPickerOpen(false)}>
              <Text style={styles.pickerDone}>Done</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.searchInput}
            placeholder="Search contacts…"
            placeholderTextColor={Beacon.faint}
            value={search}
            onChangeText={setSearch}
            autoFocus
          />
          <FlatList
            data={filtered}
            keyExtractor={item => (item as any).id ?? item.name ?? String(Math.random())}
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
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  pickerTitle: { fontSize: 18, fontWeight: '800', color: Beacon.text },
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
