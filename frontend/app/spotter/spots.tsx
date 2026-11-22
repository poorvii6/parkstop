import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, ActivityIndicator, Platform, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import MapLibreView from '../../components/MapLibreView';
import apiClient from '../../api/client';
import { presentError } from '../../utils/authErrors';
import { useOnlineRefresh } from '../../hooks/useOnlineRefresh';
import SpotVerificationBadge from '../../components/spotter/SpotVerificationBadge';
import { LoadFailed, loadErrorText } from '../../components/LoadFailed';
import { SC, TF, SP, RAD, SS, ICON } from '../../constants/SpotterTheme';

/**
 * When a GPS fix is too coarse to place a spot with.
 *
 * NOT a round number picked for feel. The desk review measures the distance
 * between this pin and the address on the owner's document, and
 * SpotVerificationPolicy bands that at ADDRESS_CONSISTENT_M = 150 m (consistent)
 * and ADDRESS_REVIEW_M = 1000 m (needs a human). So the pin's own uncertainty
 * is subtracted from the band before anyone has done anything wrong: a ±50 m
 * capture spends a third of the inner band on nothing, and a bad pin does not
 * merely sit in the wrong place — it corrupts the check whose whole job is to
 * notice a spot being in the wrong place. Two failures from one cause.
 *
 * 30 m is a fifth of that band: loose enough that an ordinary phone outdoors
 * clears it in seconds, tight enough that the check still has most of its
 * margin to work with.
 */
const POOR_FIX_M = 30;

/**
 * How long a held fix stays authoritative before a worse one may replace it.
 *
 * Without this the pin would stick to the best fix ever seen, and an owner who
 * walked from the gate to the actual bay would watch it refuse to follow them.
 */
const FIX_STALE_MS = 15000;

export default function SpotsScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<'list' | 'create'>('list');

  // List state
  const [mySpots, setMySpots] = useState<any[]>([]);
  const [loadingSpots, setLoadingSpots] = useState(true);
  // Tracked separately from an empty list. A failed load used to fall straight
  // through to "No Spots Yet", which invites an owner who already has four
  // driveways to create a fifth copy of one.
  const [spotsError, setSpotsError] = useState('');

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

  /**
   * Why the location fetch needs an error state of its own.
   *
   * Both failure paths below used to exit without touching any state: a denied
   * permission returned, and a thrown error went to console.log. Nothing else
   * writes latitude, so the map preview kept rendering its placeholder and the
   * owner sat on "Waiting for GPS signal..." forever, with no error and nothing
   * to press. The same lie the rest of the app stopped telling.
   *
   * The tick re-runs the effect, which re-requests the permission — on Android
   * a denial that was not "never ask again" will prompt again, so the retry is
   * worth offering rather than sending them straight to Settings.
   */
  const [locationError, setLocationError] = useState('');
  const [locationRetryTick, setLocationRetryTick] = useState(0);

  /**
   * How precise the pin currently on screen is, in metres.
   *
   * null means "no GPS claim attached to it" — either nothing has been
   * captured yet, or the owner placed the pin by hand on the map, which is
   * exact by intent and has no accuracy to report or warn about.
   *
   * detectLocation already told the owner "±Nm" in an alert and then threw the
   * number away. Holding it is what lets the screen show it while watching and
   * warn at the moment of saving, which is the moment that costs something.
   */
  const [pinAccuracyM, setPinAccuracyM] = useState<number | null>(null);

  /** The accuracy and age of the fix the pin came from. See acceptFix below. */
  const heldFix = useRef<{ acc: number; at: number } | null>(null);

  /**
   * Take a fix, or ignore it.
   *
   * The watcher fires every ~2 s with distanceInterval: 1, and every single
   * sample used to be written straight into the coordinate fields with no look
   * at coords.accuracy. So the pin visibly wandered while it settled, and
   * whatever it happened to be showing when the owner tapped Save is what got
   * saved. The gate from d93e9de does not help here: that one lives in
   * useInAppNavigation and governs the driver's navigation fixes — it was one
   * file, and this screen talks to expo-location directly.
   *
   * The rule: ignore a fix that is BOTH coarser than the band tolerance AND
   * worse than what the pin already shows. Anything else is taken.
   *
   * It is deliberately not "keep the best fix ever seen". This is a static
   * capture, so converging is right, but an owner does walk from the gate to
   * the bay — and a strictly-improving rule would refuse to follow them once
   * accuracy plateaued. Good fixes are therefore always accepted, so the pin
   * still tracks real movement; only genuinely poor ones are dropped. A held
   * fix also goes stale after FIX_STALE_MS, so a long run of poor readings
   * eventually updates rather than freezing the pin forever.
   *
   * Fails open on the first fix: with nothing held, whatever arrives is taken,
   * so the preview appears as promptly as it did before.
   */
  const acceptFix = (loc: Location.LocationObject) => {
    // null accuracy means the platform will not say. Treated as the worst
    // possible rather than as fine, so it cannot displace a known-good fix.
    const acc = loc.coords.accuracy ?? Infinity;
    const held = heldFix.current;
    const stale = held !== null && Date.now() - held.at > FIX_STALE_MS;

    if (held !== null && !stale && acc > POOR_FIX_M && acc > held.acc) return;

    heldFix.current = { acc, at: Date.now() };
    setPinAccuracyM(Number.isFinite(acc) ? acc : null);

    /**
     * EIGHT DECIMAL PLACES IS ABOUT A MILLIMETRE, AND MEANS NOTHING HERE.
     *
     * A phone fix is good to metres at best — the accuracy this very function
     * gates on is typically ±5 to ±50 m. So digits three through eight are not
     * precision, they are the float's own decimal expansion written out.
     *
     * They are kept because the column is Decimal(10,8) and a round trip
     * through the form should not quietly move the pin, and because the map tap
     * and the manual fields use the same width. What they must never be read as
     * is confidence: pinAccuracyM is the only honest statement of that, which
     * is why it is shown beside the coordinates and warned about on save.
     */
    setLatitude(loc.coords.latitude.toFixed(8));
    setLongitude(loc.coords.longitude.toFixed(8));
  };

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;

    if (mode === 'create' && useLiveLocation && !editingSpotId) {
      (async () => {
        setLocationError('');
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== 'granted') {
            // Not "tap the map": with no coordinates there is no map on
            // screen, only this block. The way out is the Live GPS badge,
            // which toggles to Custom Pin and reveals the manual fields.
            setLocationError(
              'ParkStop needs location access to place this spot. Allow it and try again, '
              + 'or switch Live GPS off to enter the coordinates yourself.'
            );
            return;
          }

          const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
          acceptFix(current);

          subscription = await Location.watchPositionAsync(
            {
              accuracy: Location.Accuracy.High,
              timeInterval: 2000,
              distanceInterval: 1,
            },
            acceptFix
          );
        } catch (e) {
          console.log('Error watching live location', e);
          setLocationError(loadErrorText(e, 'Could not get your location.'));
        }
      })();
    }

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, [mode, useLiveLocation, editingSpotId, locationRetryTick]);

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
    setLoadingSpots(true);
    setSpotsError('');
    try {
      const res = await apiClient.get('/spots/dashboard');
      if (res.data?.success) {
        setMySpots(res.data.data.inventory || []);
      } else {
        setSpotsError(res.data?.message || 'Could not load your spots.');
      }
    } catch (e) {
      setSpotsError(loadErrorText(e, 'Could not load your spots.'));
    } finally {
      setLoadingSpots(false);
    }
  };

  // Refresh the spots list the moment connectivity is restored.
  useOnlineRefresh(fetchMySpots);

  const detectLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required to auto-detect your position.');
        return;
      }
      // A spot's coordinates are permanent — capture them with the strongest
      // GPS mode and tell the Spotter how precise the fix actually was.
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
      // Deliberately NOT through acceptFix: the owner asked for this one, so it
      // wins outright. It does record the accuracy, which this function used to
      // report in the alert and then throw away — so the number now survives to
      // the save-time check instead of being shown once and forgotten.
      heldFix.current = { acc: loc.coords.accuracy ?? Infinity, at: Date.now() };
      setPinAccuracyM(loc.coords.accuracy ?? null);
      setLatitude(loc.coords.latitude.toFixed(8));
      setLongitude(loc.coords.longitude.toFixed(8));
      // The accuracy is NOT repeated here. The badge shows it continuously now
      // ("Live GPS ±12m") and the save warns on a coarse one, so saying it in
      // this alert as well told a coarse capture twice and let the owner
      // dismiss the one place it persists.
      Alert.alert('📍 Location Detected', `Lat: ${loc.coords.latitude.toFixed(6)}\nLng: ${loc.coords.longitude.toFixed(6)}`);
    } catch (e) {
      Alert.alert('Error', 'Failed to get current location.');
    }
  };

  /**
   * Validate, then warn about a coarse pin before saving one.
   *
   * The warning belongs HERE and not only beside the map: an owner who taps
   * Save during the window while the fix is still settling is the case that
   * actually costs something, and that is the moment to say so.
   *
   * It does NOT block. A basement or a stilt park may never produce a good
   * fix, and refusing to save would leave those owners with no way to list at
   * all. So the warning points at the map tap, which is the honest way out,
   * and saving anyway stays one press away.
   */
  const handleCreate = () => {
    if (!title.trim()) return Alert.alert('Missing', 'Spot name is required.');
    if (!price || parseFloat(price) <= 0) return Alert.alert('Missing', 'Enter a valid price per hour.');
    if (!latitude || !longitude) return Alert.alert('Missing', 'Please detect or enter your location.');

    const totalSlots = parseInt(carSlots || '0') + parseInt(bikeSlots || '0');
    if (totalSlots <= 0) return Alert.alert('Missing', 'Add at least one parking slot.');

    if (pinAccuracyM != null && pinAccuracyM > POOR_FIX_M) {
      return Alert.alert(
        'This pin may be off',
        `Your GPS is only accurate to about ±${Math.round(pinAccuracyM)} m right now, so this pin `
        + 'could be that far from the actual bay.\n\n'
        + 'We check this pin against the address on your document, so a loose one can hold up '
        + 'your verification. Tapping the spot on the map is more exact than waiting.',
        [
          { text: 'Set it on the map', style: 'cancel' },
          { text: 'Save anyway', onPress: () => submitSpot(totalSlots) },
        ]
      );
    }

    submitSpot(totalSlots);
  };

  /** The save itself. totalSlots is passed rather than recomputed so the
   *  figure that was validated is the figure that is sent. */
  const submitSpot = async (totalSlots: number) => {
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
      presentError(e, 'Failed to save spot.');
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
            presentError(e, 'Failed to delete.');
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
              <Ionicons name="person" size={ICON.row} color={SC.info} />
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
            <Ionicons name="list" size={ICON.row} color={mode === 'list' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'list' && { color: '#FFF' }]}>My Spots</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'create' && s.toggleActive]}
            onPress={() => { setMode('create'); setEditingSpotId(null); setTitle(''); setAddress(''); setPrice(''); setPickedImages([]); setUseLiveLocation(true); }}
          >
            <Ionicons name="add-circle" size={ICON.row} color={mode === 'create' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'create' && { color: '#FFF' }]}>{editingSpotId ? 'Edit Spot' : 'Create New'}</Text>
          </TouchableOpacity>
        </View>

        {mode === 'list' ? (
          /* ── MY SPOTS LIST ──────────────────────────────────── */
          <>
            {loadingSpots ? (
              <ActivityIndicator color={SC.accent} style={{ marginTop: 40 }} />
            ) : spotsError ? (
              <LoadFailed message={spotsError} onRetry={fetchMySpots} what="your spots" />
            ) : mySpots.length === 0 ? (
              <View style={[SS.card, { alignItems: 'center', paddingVertical: 40 }]}>
                <View style={s.emptyIconBg}>
                  <Ionicons name="location-outline" size={ICON.hero} color={SC.accent} />
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
                        <Ionicons name="location" size={ICON.tile} color={SC.accent} />
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
                        <Ionicons name="pencil" size={ICON.label} color="#3b82f6" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={s.deleteBtn}
                        onPress={() => handleDelete(spot.id)}
                      >
                        <Ionicons name="trash-outline" size={ICON.label} color={SC.error} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  {/*
                    Whether a driver can actually see this spot, and why not —
                    and now a way in. Each spot is verified on its own, so this
                    opens THIS spot's document, not an account-wide one.
                  */}
                  <SpotVerificationBadge
                    v={spot.verification}
                    onPress={() => router.push(`/spotter/spot-verification/${spot.id}` as any)}
                  />
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
            {/*
              Said BEFORE the form, not after submitting.
              A new spot is not visible to drivers until its own address is
              checked -- being a verified owner is not enough, because
              verification approves a person and this is a place. Burying that
              until the end would mean someone fills in a listing believing it
              goes live when they tap Create.
            */}
            {!editingSpotId && (
              <View style={s.verifyNotice}>
                <Ionicons name="information-circle" size={ICON.row} color={SC.info} />
                <Text style={s.verifyNoticeText}>
                  New spots are not visible to drivers straight away. After you create this
                  one, send us a document proving who owns its address — a khata certificate,
                  sale deed, property tax receipt or encumbrance certificate{' '}
                  <Text style={{ fontWeight: '800' }}>in your own name</Text>. A utility bill is
                  not enough. If you rent, you will also need your landlord&apos;s signed consent.
                  We verify it and list the spot within 48 hours of a complete submission.
                </Text>
              </View>
            )}
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
                      <Ionicons name="close" size={ICON.inline} color="#FFF" />
                    </TouchableOpacity>
                  </View>
                ))}
                {pickedImages.length < 5 && (
                  <TouchableOpacity 
                    onPress={pickImages} 
                    style={{ width: 72, height: 72, backgroundColor: SC.bgCard, borderRadius: RAD.sm, borderStyle: 'dashed', borderWidth: 1.5, borderColor: SC.borderActive, justifyContent: 'center', alignItems: 'center' }}
                  >
                    <Ionicons name="camera" size={ICON.tile} color={SC.accent} />
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
                    {/*
                      The accuracy, while watching — not only in an alert after
                      pressing Detect. An owner cannot judge a pin they are
                      given no measure of, and this is the number the desk
                      review's 150 m band is spent on.
                    */}
                    {useLiveLocation
                      ? (pinAccuracyM != null ? `Live GPS ±${Math.round(pinAccuracyM)}m` : 'Live GPS Active')
                      : 'Custom Pin Set'}
                  </Text>
                </TouchableOpacity>
              </View>
              
              {/* Map Preview Webview */}
              {latitude && longitude ? (
                <View style={{ height: 200, borderRadius: RAD.md, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: SC.border }}>
                  {/*
                    userLocation is the SPOT here, not the owner — the one
                    place in the app where that prop means something else.

                    Left as it is rather than renamed, because the behaviour is
                    the behaviour this preview wants: the prop drives the
                    opening camera centre and zoom, and the follow camera keeps
                    that point in frame. Pointing it at the pin is how the
                    preview stays on the pin.

                    It does NOT draw a false "you are here". The blue dot comes
                    from showsUserLocation inside GoogleMapNative, which uses
                    the device's own fix and ignores this prop.
                  */}
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
                      // A hand-placed pin is exact by intent: there is no GPS
                      // uncertainty to report, and nothing to warn about on
                      // save. This is the honest way out of a basement or a
                      // stilt park that will never get a good fix.
                      heldFix.current = null;
                      setPinAccuracyM(null);
                      setLatitude(coords[0].toFixed(8));
                      setLongitude(coords[1].toFixed(8));
                    }}
                    hideControls={true}
                  />
                </View>
              ) : locationError ? (
                /* The fetch failed. Say so, and offer the way out. */
                <View style={{ minHeight: 200, borderRadius: RAD.md, backgroundColor: SC.bgCard, justifyContent: 'center', marginBottom: 12, borderWidth: 1, borderColor: SC.border }}>
                  <LoadFailed
                    message={locationError}
                    onRetry={() => setLocationRetryTick((t) => t + 1)}
                    what="your location"
                    compact
                  />
                </View>
              ) : (
                <View style={{ height: 200, borderRadius: RAD.md, backgroundColor: SC.bgCard, justifyContent: 'center', alignItems: 'center', marginBottom: 12, borderWidth: 1, borderColor: SC.border }}>
                  {/*
                    Only claim to be waiting when something actually is. The
                    watcher runs for a NEW spot with live location on; with a
                    custom pin chosen and no coordinates yet, nothing is
                    acquiring anything and "Waiting for GPS signal" was the
                    same kind of untruth as the eternal spinner above.
                  */}
                  {useLiveLocation && !editingSpotId ? (
                    <>
                      <ActivityIndicator color={SC.accent} size="small" />
                      <Text style={{ color: SC.textMuted, fontSize: 12, marginTop: 8, fontWeight: '700' }}>Waiting for GPS signal...</Text>
                    </>
                  ) : (
                    <Text style={{ color: SC.textMuted, fontSize: 12, fontWeight: '700', textAlign: 'center', paddingHorizontal: 24 }}>
                      Enter the coordinates below, or switch Live GPS back on.
                    </Text>
                  )}
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
                  <Ionicons name="refresh-circle" size={ICON.label} color={SC.accent} style={{ marginRight: 6 }} />
                  <Text style={{ color: SC.accent, fontSize: 12, fontWeight: '800' }}>Recenter to Live GPS Location</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginBottom: SP.xl }}>
              <View style={{ flex: 1 }}>
                <Text style={SS.inputLabel}>LATITUDE</Text>
                <TextInput
                  style={SS.input}
                  placeholder="Latitude"
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
                  placeholder="Longitude"
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
  verifyNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: SC.infoSoft,
    borderColor: SC.info + '55',
    borderWidth: 1,
    borderRadius: RAD.sm,
    padding: 12,
    marginBottom: SP.lg,
  },
  verifyNoticeText: {
    flex: 1,
    color: SC.textPrimary,
    opacity: 0.9,
    fontSize: 12,
    lineHeight: 17,
  },
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
