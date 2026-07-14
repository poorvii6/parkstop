import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, ActivityIndicator, Platform, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import MapLibreView from '../../components/MapLibreView';
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
  const [editingSpotId, setEditingSpotId] = useState<number | null>(null);
  const [pickedImages, setPickedImages] = useState<string[]>([]);
  const [useLiveLocation, setUseLiveLocation] = useState(true);

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;

    if (mode === 'create' && useLiveLocation && !editingSpotId) {
      (async () => {
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== 'granted') return;

          const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          setLatitude(current.coords.latitude.toFixed(8));
          setLongitude(current.coords.longitude.toFixed(8));

          subscription = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.High,
              timeInterval: 2000,
              distanceInterval: 1,
            },
            (loc) => {
              setLatitude(loc.coords.latitude.toFixed(8));
              setLongitude(loc.coords.longitude.toFixed(8));
            }
          );
        } catch (e) {
          console.log('Error watching live location', e);
        }
      })();
    }

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, [mode, useLiveLocation, editingSpotId]);

  const pickImages = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Denied', 'Media library access is required to add photos.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 5 - pickedImages.length,
      quality: 0.8,
    });
    if (!result.canceled) {
      const uris = result.assets.map(asset => asset.uri);
      setPickedImages(prev => [...prev, ...uris].slice(0, 5));
    }
  };

  const removePickedImage = (index: number) => {
    setPickedImages(prev => prev.filter((_, idx) => idx !== index));
  };

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
      const existingWebImages = pickedImages.filter(img => img.startsWith('http') || img.startsWith('https'));
      const localImageUris = pickedImages.filter(img => !img.startsWith('http') && !img.startsWith('https'));

      const payload = {
        title: title.trim(),
        description: description.trim(),
        price_per_hour: parseFloat(price),
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        address: address.trim() || undefined,
        total_slots: totalSlots,
        car_slots: parseInt(carSlots || '0'),
        bike_slots: parseInt(bikeSlots || '0'),
        images: existingWebImages // Keep old images
      };

      let spotId = editingSpotId;
      if (editingSpotId) {
        const res = await apiClient.put(`/spots/${editingSpotId}`, payload);
        if (res.data?.success) {
          Alert.alert('🎉 Spot Updated!', `"${title}" has been updated.`);
        }
      } else {
        const res = await apiClient.post('/spots', payload);
        if (res.data?.success) {
          spotId = res.data.data.id;
          Alert.alert('🎉 Spot Created!', `"${title}" is now live on ParkStop.`);
        }
      }

      // Upload local images if any
      if (spotId && localImageUris.length > 0) {
        const formData = new FormData();
        localImageUris.forEach((uri, idx) => {
          const uriParts = uri.split('.');
          const fileType = uriParts[uriParts.length - 1] || 'jpg';
          
          // React Native FormData file append format
          formData.append('images', {
            uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
            name: `photo_${idx}_${Date.now()}.${fileType}`,
            type: `image/${fileType === 'jpg' ? 'jpeg' : fileType}`
          } as any);
        });

        await apiClient.post(`/spots/${spotId}/images`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
      }

      setTitle('');
      setDescription('');
      setCarSlots('1');
      setBikeSlots('0');
      setPrice('');
      setAddress('');
      setLatitude('');
      setLongitude('');
      setPickedImages([]);
      setEditingSpotId(null);
      setMode('list');
      setLoadingSpots(true);
      fetchMySpots();
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Failed to save spot.');
    } finally {
      setCreating(false);
    }
  };

  const handleEditClick = (spot: any) => {
    setEditingSpotId(spot.id);
    setTitle(spot.title || '');
    setDescription(spot.description || '');
    setCarSlots(spot.car_slots?.toString() || '0');
    setBikeSlots(spot.bike_slots?.toString() || '0');
    setPrice(spot.price_per_hour?.toString() || '');
    setAddress(spot.address || '');
    setLatitude(spot.latitude?.toString() || '');
    setLongitude(spot.longitude?.toString() || '');
    setPickedImages(spot.images || []); // Load existing pictures
    setMode('create');
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
              <Text style={SS.statusLabel}>SPOT OWNER STATUS</Text>
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
          {mode === 'list' ? 'My Spots' : (editingSpotId ? 'Edit Listing' : 'New Listing')}
        </Text>
        <Text style={{ color: SC.textSecondary, ...TF.bodySm, marginBottom: SP.xl }}>
          {mode === 'list' ? 'Manage your parking listings.' : 'Update or list a parking space on ParkStop.'}
        </Text>

        {/* MODE TOGGLE */}
        <View style={s.toggleRow}>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'list' && s.toggleActive]}
            onPress={() => { setMode('list'); setEditingSpotId(null); setTitle(''); setAddress(''); setPrice(''); setPickedImages([]); setUseLiveLocation(true); }}
          >
            <Ionicons name="list" size={18} color={mode === 'list' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'list' && { color: '#FFF' }]}>My Spots</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'create' && s.toggleActive]}
            onPress={() => { setMode('create'); setEditingSpotId(null); setTitle(''); setAddress(''); setPrice(''); setPickedImages([]); setUseLiveLocation(true); }}
          >
            <Ionicons name="add-circle" size={18} color={mode === 'create' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'create' && { color: '#FFF' }]}>{editingSpotId ? 'Edit Spot' : 'Create New'}</Text>
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
                      {spot.images && spot.images.length > 0 ? (
                        <Image source={{ uri: spot.images[0] }} style={{ width: '100%', height: '100%', borderRadius: 8 }} />
                      ) : (
                        <Ionicons name="location" size={20} color={SC.accent} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>{spot.title}</Text>
                      <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 2 }}>
                        {spot.car_slots} Car · {spot.bike_slots} Bike
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        style={[s.deleteBtn, { backgroundColor: 'rgba(59,130,246,0.1)' }]}
                        onPress={() => handleEditClick(spot)}
                      >
                        <Ionicons name="pencil" size={16} color="#3b82f6" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={s.deleteBtn}
                        onPress={() => handleDelete(spot.id)}
                      >
                        <Ionicons name="trash-outline" size={16} color={SC.error} />
                      </TouchableOpacity>
                    </View>
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

            {/* PHOTOS OF THE SPOT */}
            <View style={SS.inputGroup}>
              <Text style={SS.inputLabel}>PHOTOS OF THE SPOT (MAX 5)</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexDirection: 'row', marginTop: 10, marginBottom: 4 }}>
                {pickedImages.map((uri, idx) => (
                  <View key={idx} style={{ position: 'relative', width: 72, height: 72, marginRight: 12, borderRadius: RAD.sm, overflow: 'hidden', borderWidth: 1, borderColor: SC.border }}>
                    <Image source={{ uri }} style={{ width: '100%', height: '100%' }} />
                    <TouchableOpacity 
                      onPress={() => removePickedImage(idx)} 
                      style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10, width: 20, height: 20, justifyContent: 'center', alignItems: 'center' }}
                    >
                      <Ionicons name="close" size={14} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                ))}
                {pickedImages.length < 5 && (
                  <TouchableOpacity 
                    onPress={pickImages} 
                    style={{ width: 72, height: 72, backgroundColor: SC.bgCard, borderRadius: RAD.sm, borderStyle: 'dashed', borderWidth: 1.5, borderColor: SC.borderActive, justifyContent: 'center', alignItems: 'center' }}
                  >
                    <Ionicons name="camera" size={22} color={SC.accent} />
                    <Text style={{ color: SC.textMuted, fontSize: 9, marginTop: 4, fontWeight: '800' }}>Add Photo</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>
            </View>

            {/* LOCATION SECTION WITH LIVE MAP */}
            <View style={SS.inputGroup}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Text style={SS.inputLabel}>SPOT LOCATION *</Text>
                
                {/* Live GPS / Custom Marker Status Toggle */}
                <TouchableOpacity 
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    if (!useLiveLocation) {
                      setUseLiveLocation(true);
                    } else {
                      setUseLiveLocation(false);
                    }
                  }}
                  style={{ 
                    flexDirection: 'row', 
                    alignItems: 'center', 
                    backgroundColor: useLiveLocation ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.12)', 
                    paddingHorizontal: 8, 
                    paddingVertical: 3, 
                    borderRadius: RAD.sm, 
                    borderWidth: 1, 
                    borderColor: useLiveLocation ? 'rgba(16,185,129,0.3)' : 'rgba(59,130,246,0.3)' 
                  }}
                >
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: useLiveLocation ? '#10b981' : '#3b82f6', marginRight: 5 }} />
                  <Text style={{ color: useLiveLocation ? '#10b981' : '#3b82f6', fontSize: 10, fontWeight: '800' }}>
                    {useLiveLocation ? 'Live GPS Active' : 'Custom Pin Set'}
                  </Text>
                </TouchableOpacity>
              </View>
              
              {/* Map Preview Webview */}
              {latitude && longitude ? (
                <View style={{ height: 200, borderRadius: RAD.md, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: SC.border }}>
                  <MapLibreView
                    userLocation={{ lat: parseFloat(latitude), lng: parseFloat(longitude) }}
                    markers={[{
                      id: 'new_spot',
                      lat: parseFloat(latitude),
                      lng: parseFloat(longitude),
                      price: parseFloat(price) || 0,
                      available: true,
                      title: title || 'New Parking Spot'
                    }]}
                    onMapPress={(coords) => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setUseLiveLocation(false); // Disable live tracking when placing custom pin
                      setLatitude(coords[0].toFixed(8));
                      setLongitude(coords[1].toFixed(8));
                    }}
                    hideControls={true}
                  />
                </View>
              ) : (
                <View style={{ height: 200, borderRadius: RAD.md, backgroundColor: SC.bgCard, justifyContent: 'center', alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: SC.border }}>
                  <ActivityIndicator color={SC.accent} size="small" />
                  <Text style={{ color: SC.textMuted, fontSize: 12, marginTop: 8, fontWeight: '700' }}>Waiting for GPS signal...</Text>
                </View>
              )}

              {/* Reset to GPS Button if custom pin is active */}
              {!useLiveLocation && !editingSpotId && (
                <TouchableOpacity 
                  onPress={async () => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setUseLiveLocation(true);
                  }}
                  style={{ 
                    flexDirection: 'row', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    backgroundColor: 'rgba(255,255,255,0.04)', 
                    paddingVertical: 10, 
                    borderRadius: RAD.sm, 
                    borderWidth: 1, 
                    borderColor: 'rgba(255,255,255,0.08)',
                    marginBottom: 12
                  }}
                >
                  <Ionicons name="refresh-circle" size={16} color={SC.accent} style={{ marginRight: 6 }} />
                  <Text style={{ color: SC.accent, fontSize: 12, fontWeight: '800' }}>Recenter to Live GPS Location</Text>
                </TouchableOpacity>
              )}
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
                <Text style={SS.primaryBtnText}>{editingSpotId ? 'Save Changes' : 'Create Spot'}</Text>
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
