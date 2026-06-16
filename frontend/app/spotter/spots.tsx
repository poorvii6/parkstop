import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';
import apiClient from '../../api/client';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';

export default function SpotsScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<'list' | 'create'>('list');

  // List state
  const [mySpots, setMySpots] = useState<any[]>([]);
  const [loadingSpots, setLoadingSpots] = useState(true);

  // Create form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [carSlots, setCarSlots] = useState('1');
  const [bikeSlots, setBikeSlots] = useState('0');
  const [price, setPrice] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchMySpots();
  }, []);

  const fetchMySpots = async () => {
    try {
      const res = await apiClient.get('/spots/dashboard');
      if (res.data?.success) {
        setMySpots(res.data.data.inventory || []);
      }
    } catch (e) {
      console.log('Error fetching spots', e);
    } finally {
      setLoadingSpots(false);
    }
  };

  const detectLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required to auto-detect your position.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setLatitude(loc.coords.latitude.toFixed(8));
      setLongitude(loc.coords.longitude.toFixed(8));
      Alert.alert('📍 Location Detected', `Lat: ${loc.coords.latitude.toFixed(6)}\nLng: ${loc.coords.longitude.toFixed(6)}`);
    } catch (e) {
      Alert.alert('Error', 'Failed to get current location.');
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) return Alert.alert('Missing', 'Spot name is required.');
    if (!price || parseFloat(price) <= 0) return Alert.alert('Missing', 'Enter a valid price per hour.');
    if (!latitude || !longitude) return Alert.alert('Missing', 'Please detect or enter your location.');

    const totalSlots = parseInt(carSlots || '0') + parseInt(bikeSlots || '0');
    if (totalSlots <= 0) return Alert.alert('Missing', 'Add at least one parking slot.');

    setCreating(true);
    try {
      const res = await apiClient.post('/spots', {
        title: title.trim(),
        description: description.trim(),
        price_per_hour: parseFloat(price),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        address: address.trim() || undefined,
        total_slots: totalSlots,
        car_slots: parseInt(carSlots || '0'),
        bike_slots: parseInt(bikeSlots || '0'),
      });

      if (res.data?.success) {
        Alert.alert('🎉 Spot Created!', `"${title}" is now live on ParkStop.`);
        setTitle('');
        setDescription('');
        setCarSlots('1');
        setBikeSlots('0');
        setPrice('');
        setAddress('');
        setLatitude('');
        setLongitude('');
        setMode('list');
        setLoadingSpots(true);
        fetchMySpots();
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Failed to create spot.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (spotId: number) => {
    Alert.alert('Delete Spot', 'Are you sure you want to remove this spot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await apiClient.delete(`/spots/${spotId}`);
            Alert.alert('Deleted', 'Spot removed successfully.');
            setLoadingSpots(true);
            fetchMySpots();
          } catch (e: any) {
            Alert.alert('Error', e.response?.data?.message || 'Failed to delete.');
          }
        },
      },
    ]);
  };

  return (
    <View style={SS.page}>
      {/* HEADER */}
      <SafeAreaView edges={['top']} style={SS.headerSafe}>
        <View style={SS.header}>
          <Text style={SS.logoText}>
            <Text style={SS.logoAccent}>P</Text>arkStop
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={SS.statusBox}>
              <Text style={SS.statusLabel}>SPOTTER STATUS</Text>
              <View style={SS.statusRow}>
                <Text style={SS.statusText}>Active</Text>
                <View style={SS.statusDot} />
              </View>
            </View>
            <TouchableOpacity onPress={() => router.push('/modal')} style={SS.profileBtn}>
              <Ionicons name="person" size={18} color={SC.info} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={SS.scrollContent}>
        {/* TITLE & MODE TOGGLE */}
        <Text style={{ color: SC.textPrimary, ...TF.h1, marginBottom: 6 }}>
          {mode === 'list' ? 'My Spots' : 'New Listing'}
        </Text>
        <Text style={{ color: SC.textSecondary, ...TF.bodySm, marginBottom: SP.xl }}>
          {mode === 'list' ? 'Manage your parking listings.' : 'List a new parking space on ParkStop.'}
        </Text>

        {/* MODE TOGGLE */}
        <View style={s.toggleRow}>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'list' && s.toggleActive]}
            onPress={() => setMode('list')}
          >
            <Ionicons name="list" size={18} color={mode === 'list' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'list' && { color: '#FFF' }]}>My Spots</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'create' && s.toggleActive]}
            onPress={() => setMode('create')}
          >
            <Ionicons name="add-circle" size={18} color={mode === 'create' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'create' && { color: '#FFF' }]}>Create New</Text>
          </TouchableOpacity>
        </View>

        {mode === 'list' ? (
          /* ── MY SPOTS LIST ──────────────────────────────────── */
          <>
            {loadingSpots ? (
              <ActivityIndicator color={SC.accent} style={{ marginTop: 40 }} />
            ) : mySpots.length === 0 ? (
              <View style={[SS.card, { alignItems: 'center', paddingVertical: 40 }]}>
                <View style={s.emptyIconBg}>
                  <Ionicons name="location-outline" size={40} color={SC.accent} />
                </View>
                <Text style={{ color: SC.textPrimary, ...TF.h3, marginTop: 16 }}>No Spots Yet</Text>
                <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 6, textAlign: 'center' }}>
                  Create your first parking listing to start earning.
                </Text>
                <TouchableOpacity
                  style={[SS.primaryBtn, { marginTop: 20, paddingHorizontal: 28 }]}
                  onPress={() => setMode('create')}
                >
                  <Text style={SS.primaryBtnText}>Create Spot</Text>
                </TouchableOpacity>
              </View>
            ) : (
              mySpots.map((spot: any, i: number) => (
                <View key={i} style={s.spotCard}>
                  <View style={s.spotHeader}>
                    <View style={s.spotIconBox}>
                      <Ionicons name="location" size={20} color={SC.accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>{spot.title}</Text>
                      <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 2 }}>
                        {spot.car_slots} Car · {spot.bike_slots} Bike
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={s.deleteBtn}
                      onPress={() => handleDelete(spot.id)}
                    >
                      <Ionicons name="trash-outline" size={16} color={SC.error} />
                    </TouchableOpacity>
                  </View>
                  <View style={s.spotStatsRow}>
                    <View style={s.spotStat}>
                      <Text style={s.spotStatValue}>{spot.total_slots}</Text>
                      <Text style={s.spotStatLabel}>Total</Text>
                    </View>
                    <View style={s.spotStat}>
                      <Text style={[s.spotStatValue, { color: SC.success }]}>{spot.available_slots}</Text>
                      <Text style={s.spotStatLabel}>Available</Text>
                    </View>
                    <View style={s.spotStat}>
                      <Text style={[s.spotStatValue, { color: SC.warning }]}>{spot.total_slots - spot.available_slots}</Text>
                      <Text style={s.spotStatLabel}>Occupied</Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </>
        ) : (
          /* ── CREATE FORM ─────────────────────────────────────── */
          <View style={SS.glassCard}>
            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>SPOT NAME *</Text>
              <TextInput
                style={SS.input}
                placeholder="e.g. Home Garage Slot"
                placeholderTextColor={SC.textDisabled}
                value={title}
                onChangeText={setTitle}
              />
            </View>

            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>DESCRIPTION</Text>
              <TextInput
                style={[SS.input, { height: 80, textAlignVertical: 'top' }]}
                placeholder="Covered parking near main road..."
                placeholderTextColor={SC.textDisabled}
                value={description}
                onChangeText={setDescription}
                multiline
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 0 }}>
              <View style={[SS.inputGroup, { flex: 1 }]}>
                <Text style={SS.inputLabel}>CAR SLOTS</Text>
                <TextInput
                  style={SS.input}
                  placeholder="1"
                  placeholderTextColor={SC.textDisabled}
                  value={carSlots}
                  onChangeText={setCarSlots}
                  keyboardType="number-pad"
                />
              </View>
              <View style={[SS.inputGroup, { flex: 1 }]}>
                <Text style={SS.inputLabel}>BIKE SLOTS</Text>
                <TextInput
                  style={SS.input}
                  placeholder="0"
                  placeholderTextColor={SC.textDisabled}
                  value={bikeSlots}
                  onChangeText={setBikeSlots}
                  keyboardType="number-pad"
                />
              </View>
            </View>

            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>PRICE PER HOUR (₹) *</Text>
              <TextInput
                style={SS.input}
                placeholder="50"
                placeholderTextColor={SC.textDisabled}
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
              />
            </View>

            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>ADDRESS</Text>
              <TextInput
                style={SS.input}
                placeholder="123 Main Street, City"
                placeholderTextColor={SC.textDisabled}
                value={address}
                onChangeText={setAddress}
              />
            </View>

            {/* LOCATION SECTION */}
            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>LOCATION *</Text>
              <TouchableOpacity style={s.locationBtn} onPress={detectLocation}>
                <Ionicons name="navigate" size={18} color={SC.accent} />
                <Text style={s.locationBtnText}>
                  {latitude && longitude ? `${latitude}, ${longitude}` : 'Tap to detect your location'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginBottom: SP.xl }}>
              <View style={{ flex: 1 }}>
                <Text style={SS.inputLabel}>LATITUDE</Text>
                <TextInput
                  style={SS.input}
                  placeholder="12.9716"
                  placeholderTextColor={SC.textDisabled}
                  value={latitude}
                  onChangeText={setLatitude}
                  keyboardType="decimal-pad"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={SS.inputLabel}>LONGITUDE</Text>
                <TextInput
                  style={SS.input}
                  placeholder="77.5946"
                  placeholderTextColor={SC.textDisabled}
                  value={longitude}
                  onChangeText={setLongitude}
                  keyboardType="decimal-pad"
                />
              </View>
            </View>

            <TouchableOpacity
              style={[SS.primaryBtn, creating && { opacity: 0.7 }]}
              onPress={handleCreate}
              disabled={creating}
            >
              {creating ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Text style={SS.primaryBtnText}>List Property</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: SP.xl,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: RAD.sm,
    backgroundColor: SC.bgCard,
    borderWidth: 1,
    borderColor: SC.border,
  },
  toggleActive: {
    backgroundColor: SC.accent,
    borderColor: SC.accent,
  },
  toggleText: {
    color: SC.textMuted,
    ...TF.btnSecondary,
  },

  emptyIconBg: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: SC.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },

  spotCard: {
    backgroundColor: SC.bgCard,
    borderRadius: RAD.lg,
    padding: SP.cardPadding,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: SC.border,
  },
  spotHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  spotIconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: SC.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  deleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: SC.errorSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
  spotStatsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  spotStat: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: RAD.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  spotStatValue: {
    color: SC.textPrimary,
    ...TF.medValue,
  },
  spotStatLabel: {
    color: SC.textMuted,
    ...TF.labelSm,
    marginTop: 2,
  },

  locationBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: SC.accentSoft,
    borderRadius: RAD.sm,
    padding: 14,
    borderWidth: 1,
    borderColor: SC.borderActive,
    borderStyle: 'dashed',
  },
  locationBtnText: {
    color: SC.accent,
    ...TF.bodyBold,
    fontSize: 13,
    flex: 1,
  },
});
