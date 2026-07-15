import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Switch, Alert, Platform, Modal, KeyboardAvoidingView, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../api/client';
import DateTimePicker from '@react-native-community/datetimepicker';

// Unified colors matching SpotterTheme
const C = {
  bg: '#0C0C14', card: '#161622', elevated: '#1C1C2E',
  accent: '#FF5733', accentSoft: 'rgba(255,87,51,0.12)',
  success: '#22C55E', successSoft: 'rgba(34,197,94,0.12)',
  warning: '#F59E0B', warningSoft: 'rgba(245,158,11,0.12)',
  info: '#3B82F6', infoSoft: 'rgba(59,130,246,0.12)',
  error: '#EF4444', errorSoft: 'rgba(239,68,68,0.12)',
  text: '#FFF', textSec: 'rgba(255,255,255,0.55)',
  textMut: 'rgba(255,255,255,0.35)', textDis: 'rgba(255,255,255,0.18)',
  border: 'rgba(255,255,255,0.08)', borderAcc: 'rgba(255,87,51,0.4)',
};

type Screen = 'profile' | 'personal_info' | 'payouts' | 'id_status' | 'legal' | 'alerts' | 'saved_spots' | 'recent_bookings';

export default function ProfileModal() {
  const router = useRouter();
  const [profile, setProfile] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>('profile');
  const [alerts, setAlerts] = useState({ push: true, email: true, sms: false });
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editDob, setEditDob] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [savedSpots, setSavedSpots] = useState<any[]>([]);
  const [recentBookings, setRecentBookings] = useState<any[]>([]);
  const [selectedBookingForReceipt, setSelectedBookingForReceipt] = useState<any>(null);

  // Role switching registration states
  const [showRoleRegModal, setShowRoleRegModal] = useState(false);
  const [regAddress, setRegAddress] = useState('');
  const [regDob, setRegDob] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPayoutMode, setRegPayoutMode] = useState<'upi' | 'bank'>('upi');
  const [regUpiId, setRegUpiId] = useState('');
  const [regBankAccountNo, setRegBankAccountNo] = useState('');
  const [regBankIfsc, setRegBankIfsc] = useState('');
  const [regBankAccountName, setRegBankAccountName] = useState('');
  const [regSubmitting, setRegSubmitting] = useState(false);

  useEffect(() => { fetchProfile(); }, []);

  const fetchProfile = async () => {
    try {
      const res = await apiClient.get('/auth/profile');
      if (res.data.success) {
        const u = res.data.data.user;
        const s = res.data.data.stats;
        setProfile(u);
        setStats(s);
        setEditName(u.full_name || u.name || '');
        setEditPhone(u.phone || '');
        setEditAddress(u.address || '');
        setEditDob(u.dob || '');

        if (u.role.toUpperCase() === 'FINDER') {
           apiClient.get('/saved-spots').then(r => setSavedSpots(r.data.data || []));
           apiClient.get('/bookings/my-bookings').then(r => {
             const b = r.data.data || [];
             setRecentBookings(b.slice(0, 10)); // Get last 10 bookings
           });
        }
      }
    } catch (e) { console.log('Profile fetch error', e); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    const backAction = () => {
      if (screen !== 'profile') {
        setScreen('profile');
        return true;
      }
      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [screen]);

  const handleBack = () => {
    if (screen === 'profile') {
      if (router.canDismiss()) {
        router.dismiss();
      } else {
        router.back();
      }
    } else {
      setScreen('profile');
    }
  };

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      const res = await apiClient.put('/auth/profile', { 
        name: editName, 
        phone: editPhone,
        address: editAddress,
        dob: editDob
      });
      if (res.data.success) {
        setProfile(res.data.data);
        Alert.alert('✅ Updated', 'Profile saved successfully.');
        setScreen('profile');
      }
    } catch (e) { Alert.alert('Error', 'Failed to update profile.'); }
    finally { setUpdating(false); }
  };

  const handleSignOut = async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: async () => {
        try { await apiClient.post('/auth/logout'); } catch (e) {}
        await AsyncStorage.multiRemove(['access_token', 'user_role', 'discovered_api_url', 'is_dual_user']);
        router.replace('/login');
      }},
    ]);
  };

  const handleSwitchRole = async () => {
    const currentRole = (profile?.role || '').toLowerCase();
    const newRole = currentRole === 'spotter' ? 'finder' : 'spotter';

    // Handle offline guest mode
    const token = await AsyncStorage.getItem('access_token');
    if (token === 'offline_token') {
      const nextRole = newRole.toUpperCase();
      await AsyncStorage.setItem('user_role', nextRole);
      router.replace(nextRole === 'FINDER' ? '/finder' : '/spotter');
      return;
    }

    const isRegistered = newRole === 'finder' ? profile?.is_finder_registered : profile?.is_spotter_registered;

    if (!isRegistered) {
      setRegPhone(profile?.phone || '');
      setRegAddress(profile?.address || '');
      setRegDob(profile?.dob || '');
      setRegUpiId(profile?.upi_id || '');
      setRegBankAccountNo(profile?.bank_account_number || '');
      setRegBankIfsc(profile?.bank_ifsc || '');
      setRegBankAccountName(profile?.bank_account_name || profile?.full_name || '');
      setRegPayoutMode(profile?.payout_mode || 'upi');
      setShowRoleRegModal(true);
      return;
    }

    Alert.alert('Switch Role', `Switch to ${newRole.charAt(0).toUpperCase() + newRole.slice(1)} mode?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Switch', onPress: async () => {
        try {
          const res = await apiClient.post('/auth/switch-role', { newRole });
          if (res.data.success) {
            await AsyncStorage.setItem('user_role', res.data.data.role.toUpperCase());
            await AsyncStorage.setItem('is_dual_user', 'true');
            router.replace(newRole === 'finder' ? '/finder' : '/spotter');
          }
        } catch (e: any) { Alert.alert('Error', e.response?.data?.message || 'Failed to switch role.'); }
      }},
    ]);
  };

  const handleRoleRegistrationSubmit = async () => {
    const currentRole = (profile?.role || '').toLowerCase();
    const newRole = currentRole === 'spotter' ? 'finder' : 'spotter';

    if (newRole === 'spotter') {
      if (!regAddress || !regDob || !regPhone) {
        return Alert.alert('Oops', 'Please fill in address, DOB, and phone number.');
      }
      if (regPayoutMode === 'upi' && !regUpiId) {
        return Alert.alert('Oops', 'Please enter your UPI ID.');
      }
      if (regPayoutMode === 'bank' && (!regBankAccountNo || !regBankIfsc || !regBankAccountName)) {
        return Alert.alert('Oops', 'Please fill in all bank details.');
      }
    }

    setRegSubmitting(true);
    try {
      const regDetails = {
        address: regAddress,
        dob: regDob,
        phone: regPhone,
        payout_mode: regPayoutMode,
        upi_id: regPayoutMode === 'upi' ? regUpiId : null,
        bank_account_number: regPayoutMode === 'bank' ? regBankAccountNo : null,
        bank_ifsc: regPayoutMode === 'bank' ? regBankIfsc : null,
        bank_account_name: regPayoutMode === 'bank' ? regBankAccountName : null,
      };

      const res = await apiClient.post('/auth/switch-role', {
        newRole,
        registrationDetails: regDetails
      });

      if (res.data.success) {
        await AsyncStorage.setItem('user_role', res.data.data.role.toUpperCase());
        await AsyncStorage.setItem('is_dual_user', 'true');
        setShowRoleRegModal(false);
        Alert.alert('🎉 Registered', `You have registered as a ${newRole} and switched modes!`);
        router.replace(newRole === 'finder' ? '/finder' : '/spotter');
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Failed to complete registration and switch.');
    } finally {
      setRegSubmitting(false);
    }
  };

  if (loading) {
    return <View style={[st.page, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator color={C.accent} size="large" /></View>;
  }

  const name = profile?.full_name || profile?.name || 'User';
  const email = profile?.email || '';
  const role = (profile?.role || 'spotter').toUpperCase();
  const firstLetter = name.charAt(0).toUpperCase();

  /* ── Header ─────────────────────────────────────────────────── */
  const Header = ({ title, right }: { title: string; right?: React.ReactNode }) => (
    <SafeAreaView edges={['top']} style={{ backgroundColor: C.bg }}>
      <View style={st.header}>
        <TouchableOpacity onPress={handleBack} style={st.backBtn}>
          <Ionicons name="chevron-back" size={20} color="#FFF" />
        </TouchableOpacity>
        <Text style={st.headerTitle}>{title}</Text>
        <View style={{ width: 60, alignItems: 'flex-end' }}>{right}</View>
      </View>
    </SafeAreaView>
  );

  /* ── Main Profile ───────────────────────────────────────────── */
  const ProfileScreen = () => (
    <>
      <Header title="Profile" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        {/* Avatar */}
        <View style={st.avatarSection}>
          <View style={st.avatar}><Text style={st.avatarText}>{firstLetter}</Text><View style={st.onlineDot} /></View>
          <Text style={st.profileName}>{name}</Text>
          <Text style={st.profileEmail}>{email}</Text>
          <View style={st.roleBadge}><Text style={st.roleBadgeText}>{role}</Text></View>
        </View>

        {/* Stats */}
        {role === 'FINDER' ? (
          <View style={st.statsRow}>
            <View style={st.statCard}>
              <Ionicons name="car" size={22} color={C.info} />
              <Text style={st.statVal}>{stats?.totalBookings || 0}</Text>
              <Text style={st.statLbl}>TOTAL BOOKINGS</Text>
            </View>
          </View>
        ) : (
          <View style={st.statsRow}>
            <View style={st.statCard}>
              <Ionicons name="location" size={22} color={C.accent} />
              <Text style={st.statVal}>{stats?.totalSpots || 0}</Text>
              <Text style={st.statLbl}>SPOTS</Text>
            </View>
            <View style={st.statCard}>
              <FontAwesome5 name="money-bill-wave" size={18} color={C.success} />
              <Text style={st.statVal}>₹{stats?.totalEarnings || 0}</Text>
              <Text style={st.statLbl}>EARNINGS</Text>
            </View>
            <View style={st.statCard}>
              <Ionicons name="car" size={22} color={C.info} />
              <Text style={st.statVal}>{stats?.totalBookings || 0}</Text>
              <Text style={st.statLbl}>BOOKINGS</Text>
            </View>
          </View>
        )}

        {/* Account Settings */}
        <Text style={st.sectionLabel}>Account Settings</Text>
        <View style={st.listBox}>
          <ListItem icon="person" color={C.info} bg={C.infoSoft} title="Personal Information" sub={`${name}, ${editPhone || 'No phone'}`} onPress={() => setScreen('personal_info')} />
          {role === 'FINDER' && (
            <>
              <ListItem icon="bookmark" color={C.accent} bg={C.accentSoft} title="Saved Spots" sub="Quickly access your favorites" onPress={() => setScreen('saved_spots')} />
              <ListItem icon="time" color={C.success} bg={C.successSoft} title="Recent Bookings" sub="Your last 10 bookings" onPress={() => setScreen('recent_bookings')} />
            </>
          )}
          {role === 'SPOTTER' && (
            <ListItem
              icon="card"
              color={C.warning}
              bg={C.warningSoft}
              title="Payout Methods"
              sub="Bank, UPI, PayPal"
              onPress={() => {
                if (router.canDismiss()) {
                  router.dismiss();
                } else {
                  router.back();
                }
                router.push('/spotter/payout-setup');
              }}
            />
          )}
          <ListItem icon="notifications" color="#FFA500" bg="rgba(255,165,0,0.1)" title="Notification Preferences" sub="Push, Email, SMS" onPress={() => setScreen('alerts')} last={role !== 'FINDER'} />
          {role === 'FINDER' && (
            <ListItem icon="shield-checkmark" color={C.success} bg={C.successSoft} title="Identity Verification" sub="Driver License" onPress={() => setScreen('id_status')} last />
          )}
        </View>

        {/* Support & Legal */}
        <Text style={[st.sectionLabel, { marginTop: 20 }]}>Support & Legal</Text>
        <View style={st.listBox}>
          <ListItem icon="document-text" color="#999" bg="rgba(150,150,150,0.1)" title="Terms & Policies" sub="ParkStop Agreement" onPress={() => setScreen('legal')} last />
        </View>

        {/* Actions */}

        <TouchableOpacity style={st.signOutBtn} onPress={handleSignOut}>
          <Ionicons name="log-out-outline" size={20} color={C.error} />
          <Text style={st.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );

  /* ── Personal Info ──────────────────────────────────────────── */
  const PersonalInfoScreen = () => (
    <>
      <Header title="Personal Info" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        <Text style={st.formSection}>IDENTITY & CONTACT</Text>
        <View style={st.formCard}>
          <FormField icon="person" iconColor={C.info} label="FULL NAME" value={editName} onChange={setEditName} />
          <View style={st.divider} />
          <FormField icon="mail" iconColor="#FFF" label="EMAIL ADDRESS" value={email} editable={false} />
          <View style={st.divider} />
          <FormField icon="call" iconColor="#FFF" label="PHONE NUMBER" value={editPhone} onChange={setEditPhone} keyboardType="phone-pad" />
        </View>

        <Text style={[st.formSection, { marginTop: 28 }]}>ADDITIONAL DETAILS</Text>
        <View style={st.formCard}>
          <FormField icon="home" iconColor="#D2691E" label="ADDRESS" value={editAddress} onChange={setEditAddress} />
          <View style={st.divider} />
          
          {Platform.OS === 'web' ? (
            <View style={st.fieldRow}>
              <View style={st.fieldIcon}><Ionicons name="calendar" size={15} color={C.error} /></View>
              <View style={{ flex: 1, justifyContent: 'center' }}>
                <Text style={st.fieldLabel}>DATE OF BIRTH</Text>
                {React.createElement('input', {
                  type: 'date',
                  max: new Date().toISOString().split('T')[0],
                  value: (() => {
                    if (!editDob) return '';
                    const parts = editDob.split('/');
                    if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
                    return editDob;
                  })(),
                  onChange: (e: any) => {
                    const val = e.target.value;
                    if (val && val.includes('-')) {
                      const parts = val.split('-');
                      if (parts.length === 3) {
                        setEditDob(`${parts[2]}/${parts[1]}/${parts[0]}`);
                        return;
                      }
                    }
                    setEditDob(val);
                  },
                  style: {
                    backgroundColor: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: '#FFF',
                    fontSize: 15,
                    fontWeight: '600',
                    fontFamily: 'inherit',
                    padding: 0,
                    margin: 0,
                    colorScheme: 'dark',
                    width: '100%',
                  }
                })}
              </View>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setShowDatePicker(true)} activeOpacity={0.7}>
              <View style={st.fieldRow}>
                <View style={st.fieldIcon}><Ionicons name="calendar" size={15} color={C.error} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={st.fieldLabel}>DATE OF BIRTH</Text>
                  <Text style={[st.fieldText, !editDob && { color: C.textDis }]}>{editDob || 'DD/MM/YYYY'}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}

          <View style={st.divider} />
          <FormField icon="male-female" iconColor="#845EC2" label="GENDER" value="Male" editable={false} />
        </View>

        <TouchableOpacity style={st.submitBtn} onPress={handleUpdate} disabled={updating}>
          {updating ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={st.submitBtnText}>UPDATE PROFILE</Text>}
        </TouchableOpacity>

        {showDatePicker && Platform.OS !== 'web' && (
          <DateTimePicker
            value={(() => {
              if (!editDob) return new Date();
              const parts = editDob.split('/');
              if (parts.length === 3) {
                const parsed = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T12:00:00Z`);
                return isNaN(parsed.getTime()) ? new Date() : parsed;
              }
              return new Date();
            })()}
            mode="date"
            display="default"
            onChange={(event, selectedDate) => {
              setShowDatePicker(Platform.OS === 'ios');
              if (selectedDate) {
                const day = selectedDate.getDate().toString().padStart(2, '0');
                const month = (selectedDate.getMonth() + 1).toString().padStart(2, '0');
                const year = selectedDate.getFullYear();
                setEditDob(`${day}/${month}/${year}`);
              }
            }}
          />
        )}
      </ScrollView>
    </>
  );

  /* ── Payouts ────────────────────────────────────────────────── */
  const PayoutsScreen = () => (
    <>
      <Header title="Payouts" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        <Text style={st.formSection}>BANK TRANSFER</Text>
        <FormInput icon="business" label="BANK NAME" placeholder="HDFC, Chase, etc." editable={false} />
        <FormInput icon="list" label="ACCOUNT NUMBER" placeholder="••••••••" secureTextEntry editable={false} />
        <FormInput icon="card" label="IFSC / ROUTING" placeholder="••••••" secureTextEntry editable={false} />
        <Text style={[st.formSection, { marginTop: 28 }]}>DIGITAL WALLETS</Text>
        <FormInput icon="apps" label="UPI ID (VPA)" placeholder="user@upi" editable={false} />
        <FormInput icon="logo-paypal" label="PAYPAL" placeholder="" editable={false} />
      </ScrollView>
    </>
  );

  /* ── ID Status ──────────────────────────────────────────────── */
  const IdStatusScreen = () => (
    <>
      <Header title="ID Status" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        <Text style={st.formSection}>IDENTITY VERIFICATION</Text>
        <View style={st.verifiedCard}>
          <View style={st.shieldBox}><Ionicons name="shield-checkmark" size={22} color="#FFF" /></View>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>ID Verified</Text>
            <Text style={{ color: C.textSec, fontSize: 12, marginTop: 2 }}>Confirmed on April 12, 2026</Text>
          </View>
          <View style={st.checkCircle}><Ionicons name="checkmark" size={14} color="#FFF" /></View>
        </View>
        <Text style={[st.formSection, { marginTop: 28 }]}>VERIFICATION DETAILS</Text>
        <FormInput icon="card-outline" label="ID TYPE" value="Driver License" editable={false} />
        <FormInput icon="barcode-outline" label="DOCUMENT NUMBER" value="**** **** 8821" editable={false} />
      </ScrollView>
    </>
  );

  /* ── Legal ──────────────────────────────────────────────────── */
  const LegalScreen = () => (
    <>
      <Header title="Legal" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '800', marginBottom: 14 }}>ParkStop Spot Owner Terms</Text>
        <Text style={st.legalText}>By listing your property on ParkStop, you agree to provide accurate location data and ensure the safety of parked vehicles.</Text>
        {['Revenue Share: ParkStop takes a 15% platform fee.', 'Responsibilities: Ensure the spot is accessible during reserved hours.', 'Payouts: Processed every Friday for the previous week.', 'Cancellations: Repeated cancellations may lead to suspension.', 'Liability: You indemnify ParkStop against claims from property use.'].map((t, i) => (
          <Text key={i} style={st.legalItem}>{i + 1}. {t}</Text>
        ))}
        <Text style={st.legalText}>Please read our full Privacy Policy on our website.</Text>
      </ScrollView>
    </>
  );

  /* ── Alerts ─────────────────────────────────────────────────── */
  const AlertsScreen = () => (
    <>
      <Header title="Alerts" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        <Text style={st.formSection}>NOTIFICATION CHANNELS</Text>
        <AlertRow title="Push Notifications" sub="Real-time booking alerts" value={alerts.push} onToggle={(v: boolean) => setAlerts({ ...alerts, push: v })} />
        <AlertRow title="Email Summaries" sub="Daily earnings reports" value={alerts.email} onToggle={(v: boolean) => setAlerts({ ...alerts, email: v })} />
        <AlertRow title="SMS Critical Alerts" sub="Emergency spot updates" value={alerts.sms} onToggle={(v: boolean) => setAlerts({ ...alerts, sms: v })} />
      </ScrollView>
    </>
  );

  /* ── Saved Spots ────────────────────────────────────────────── */
  const SavedSpotsScreen = () => (
    <>
      <Header title="Saved Spots" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
        {savedSpots.length > 0 ? savedSpots.map(s => (
          <TouchableOpacity 
            key={s.id} 
            style={[st.alertCard, { paddingVertical: 14 }]} 
            onPress={() => {
               if (router.canDismiss()) {
                 router.dismiss();
               } else {
                 router.back();
               }
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#FFF', fontSize: 16, fontWeight: '800' }}>{s.title}</Text>
              <Text style={{ color: C.textMut, fontSize: 12, marginTop: 4 }}>₹{s.price_per_hour}/hr • {s.address || 'No address'}</Text>
            </View>
            <Ionicons name="bookmark" size={20} color={C.accent} />
          </TouchableOpacity>
        )) : (
          <Text style={{ color: C.textMut, textAlign: 'center', marginTop: 40 }}>No saved spots yet.</Text>
        )}
      </ScrollView>
    </>
  );

  /* ── Recent Bookings ────────────────────────────────────────── */
  const RecentBookingsScreen = () => {
    const totalSpend = recentBookings.reduce(
      (sum, b) => (b.payment_status === 'paid' || b.status === 'completed') ? sum + Number(b.total_price) : sum,
      0
    );

    return (
      <>
        <Header title="Recent Bookings" />
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={st.scroll}>
          {/* Total Spend Summary Card */}
          <View style={[st.statCard, { width: '100%', paddingVertical: 20, marginBottom: 20 }]}>
            <Text style={{ color: C.textSec, fontSize: 11, fontWeight: '800', letterSpacing: 1 }}>TOTAL SPEND</Text>
            <Text style={{ color: C.success, fontSize: 32, fontWeight: '900', marginTop: 4 }}>₹{totalSpend.toFixed(2)}</Text>
          </View>

          {recentBookings.length > 0 ? recentBookings.map((b, i) => (
            <TouchableOpacity 
              key={i} 
              activeOpacity={0.85}
              style={[st.alertCard, { flexDirection: 'column', alignItems: 'flex-start', marginBottom: 12 }]}
              onPress={() => setSelectedBookingForReceipt(b)}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 8 }}>
                <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>Booking #{b.id}</Text>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                  {b.payment_status === 'refunded' && (
                    <View style={{ backgroundColor: C.errorSoft, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
                      <Text style={{ color: C.error, fontSize: 9, fontWeight: '800' }}>REFUNDED</Text>
                    </View>
                  )}
                  <Text style={{ color: b.status === 'completed' ? C.success : b.status === 'cancelled' ? C.error : C.warning, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }}>{b.status}</Text>
                </View>
              </View>
              <Text style={{ color: C.textSec, fontSize: 13, marginBottom: 4, fontWeight: '600' }}>Spot: {b.parking_spots?.title}</Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', width: '100%' }}>
                <Text style={{ color: C.textMut, fontSize: 13 }}>Price: ₹{b.total_price} • Slot: {b.slot_name || 'N/A'}</Text>
                <Text style={{ color: C.info, fontSize: 12, fontWeight: '700' }}>View Receipt</Text>
              </View>
              <Text style={{ color: C.textDis, fontSize: 10, marginTop: 8 }}>{new Date(b.created_at).toLocaleString()}</Text>
            </TouchableOpacity>
          )) : (
            <Text style={{ color: C.textMut, textAlign: 'center', marginTop: 40 }}>No recent bookings.</Text>
          )}
        </ScrollView>
      </>
    );
  };

  return (
    <View style={st.page}>
      {screen === 'profile' && ProfileScreen()}
      {screen === 'personal_info' && PersonalInfoScreen()}
      {screen === 'payouts' && PayoutsScreen()}
      {screen === 'id_status' && IdStatusScreen()}
      {screen === 'legal' && LegalScreen()}
      {screen === 'alerts' && AlertsScreen()}
      {screen === 'saved_spots' && SavedSpotsScreen()}
      {screen === 'recent_bookings' && RecentBookingsScreen()}

      {/* 🧾 RECEIPT DETAIL MODAL */}
      <Modal
        visible={selectedBookingForReceipt !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedBookingForReceipt(null)}
      >
        <View style={st.modalOverlay}>
          <View style={st.modalContent}>
            <View style={st.receiptHeader}>
              <View style={st.receiptAvatar}>
                <Ionicons name="receipt" size={32} color={C.accent} />
              </View>
              <Text style={st.receiptTitle}>Parking Receipt</Text>
              <Text style={st.receiptSub}>Booking #{selectedBookingForReceipt?.id}</Text>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} style={{ marginVertical: 20, maxHeight: 350 }}>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Spot Title</Text>
                <Text style={st.receiptVal}>{selectedBookingForReceipt?.parking_spots?.title || 'N/A'}</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Address</Text>
                <Text style={[st.receiptVal, { fontSize: 13 }]} numberOfLines={2}>{selectedBookingForReceipt?.parking_spots?.address || 'N/A'}</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Reserved Slot</Text>
                <Text style={st.receiptVal}>{selectedBookingForReceipt?.slot_name || 'N/A'}</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Duration</Text>
                <Text style={st.receiptVal}>{Number(selectedBookingForReceipt?.hours || 0).toFixed(1)} hrs</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Booking Date</Text>
                <Text style={st.receiptVal}>{selectedBookingForReceipt ? new Date(selectedBookingForReceipt.created_at).toLocaleString() : 'N/A'}</Text>
              </View>

              <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 16 }} />

              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Payment Provider</Text>
                <Text style={[st.receiptVal, { textTransform: 'uppercase' }]}>{selectedBookingForReceipt?.payment_id?.startsWith('pay_') ? 'Razorpay' : selectedBookingForReceipt?.payment_id?.startsWith('pi_') ? 'Stripe' : 'N/A'}</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Transaction ID</Text>
                <Text style={[st.receiptVal, { fontSize: 11, color: C.info }]} selectable>{selectedBookingForReceipt?.payment_id || 'N/A'}</Text>
              </View>
              <View style={st.receiptRow}>
                <Text style={st.receiptLabel}>Payment Status</Text>
                <Text style={[st.receiptVal, { color: selectedBookingForReceipt?.payment_status === 'refunded' ? C.error : C.success, fontWeight: '900', textTransform: 'uppercase' }]}>{selectedBookingForReceipt?.payment_status || 'N/A'}</Text>
              </View>

              <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 16 }} />

              <View style={st.receiptRow}>
                <Text style={[st.receiptLabel, { fontSize: 16, color: '#FFF' }]}>Amount Paid</Text>
                <Text style={{ fontSize: 22, fontWeight: '900', color: C.success }}>₹{Number(selectedBookingForReceipt?.total_price || 0).toFixed(2)}</Text>
              </View>
            </ScrollView>

            <TouchableOpacity 
              style={[st.signOutBtn, { marginTop: 0 }]} 
              onPress={() => setSelectedBookingForReceipt(null)}
            >
              <Text style={{ color: C.error, fontWeight: '800' }}>Close Receipt</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 🛡️ ROLE REGISTRATION MODAL */}
      <Modal
        visible={showRoleRegModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRoleRegModal(false)}
      >
        <View style={st.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ width: '100%' }}
          >
            <View style={[st.modalContent, { maxHeight: '90%' }]}>
              <View style={st.receiptHeader}>
                <View style={st.receiptAvatar}>
                  <Ionicons name="card" size={32} color={C.accent} />
                </View>
                <Text style={st.receiptTitle}>Spot Owner Registration</Text>
                <Text style={st.receiptSub}>Complete your payout profile to list spots</Text>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} style={{ marginVertical: 15 }}>
                {/* Basic Details */}
                <Text style={st.formSection}>Basic Details</Text>
                <View style={{ marginBottom: 12 }}>
                  <Text style={st.inputLabel}>Phone Number</Text>
                  <View style={st.inputBox}>
                    <Ionicons name="call" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                    <TextInput
                      style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                      value={regPhone}
                      onChangeText={setRegPhone}
                      placeholder="+1 234 567 890"
                      placeholderTextColor={C.textDis}
                      keyboardType="phone-pad"
                    />
                  </View>
                </View>

                <View style={{ marginBottom: 12 }}>
                  <Text style={st.inputLabel}>Residential Address</Text>
                  <View style={st.inputBox}>
                    <Ionicons name="home" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                    <TextInput
                      style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                      value={regAddress}
                      onChangeText={setRegAddress}
                      placeholder="123 Main St, City"
                      placeholderTextColor={C.textDis}
                    />
                  </View>
                </View>

                <View style={{ marginBottom: 16 }}>
                  <Text style={st.inputLabel}>Date of Birth</Text>
                  <View style={st.inputBox}>
                    <Ionicons name="calendar" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                    <TextInput
                      style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                      value={regDob}
                      onChangeText={setRegDob}
                      placeholder="DD/MM/YYYY"
                      placeholderTextColor={C.textDis}
                    />
                  </View>
                </View>

                {/* Payout Details */}
                <Text style={st.formSection}>Payout Preference</Text>
                <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 4, marginBottom: 16, borderWidth: 1, borderColor: C.border }}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: regPayoutMode === 'upi' ? C.accent : 'transparent', alignItems: 'center' }}
                    onPress={() => setRegPayoutMode('upi')}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>UPI Transfer</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: regPayoutMode === 'bank' ? C.accent : 'transparent', alignItems: 'center' }}
                    onPress={() => setRegPayoutMode('bank')}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>Bank Account</Text>
                  </TouchableOpacity>
                </View>

                {regPayoutMode === 'upi' ? (
                  <View style={{ marginBottom: 12 }}>
                    <Text style={st.inputLabel}>UPI ID (VPA)</Text>
                    <View style={st.inputBox}>
                      <Ionicons name="phone-portrait-outline" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                      <TextInput
                        style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                        value={regUpiId}
                        onChangeText={setRegUpiId}
                        placeholder="username@upi"
                        placeholderTextColor={C.textDis}
                        autoCapitalize="none"
                      />
                    </View>
                  </View>
                ) : (
                  <View style={{ gap: 12 }}>
                    <View>
                      <Text style={st.inputLabel}>Bank Account Name</Text>
                      <View style={st.inputBox}>
                        <Ionicons name="person" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                        <TextInput
                          style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                          value={regBankAccountName}
                          onChangeText={setRegBankAccountName}
                          placeholder="John Doe"
                          placeholderTextColor={C.textDis}
                        />
                      </View>
                    </View>

                    <View>
                      <Text style={st.inputLabel}>Bank Account Number</Text>
                      <View style={st.inputBox}>
                        <Ionicons name="list" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                        <TextInput
                          style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                          value={regBankAccountNo}
                          onChangeText={setRegBankAccountNo}
                          placeholder="1234567890"
                          placeholderTextColor={C.textDis}
                          keyboardType="numeric"
                        />
                      </View>
                    </View>

                    <View>
                      <Text style={st.inputLabel}>Bank IFSC Code</Text>
                      <View style={st.inputBox}>
                        <Ionicons name="barcode" size={16} color={C.textMut} style={{ marginRight: 10 }} />
                        <TextInput
                          style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }}
                          value={regBankIfsc}
                          onChangeText={setRegBankIfsc}
                          placeholder="HDFC0001234"
                          placeholderTextColor={C.textDis}
                          autoCapitalize="characters"
                        />
                      </View>
                    </View>
                  </View>
                )}
              </ScrollView>

              <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
                <TouchableOpacity
                  style={[st.signOutBtn, { flex: 1, marginTop: 0, backgroundColor: 'rgba(255,255,255,0.05)', borderColor: C.border }]}
                  onPress={() => setShowRoleRegModal(false)}
                >
                  <Text style={{ color: '#FFF', fontWeight: '800' }}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[st.submitBtn, { flex: 1, marginTop: 0, height: 54, justifyContent: 'center' }]}
                  onPress={handleRoleRegistrationSubmit}
                  disabled={regSubmitting}
                >
                  {regSubmitting ? (
                    <ActivityIndicator color="#FFF" size="small" />
                  ) : (
                    <Text style={st.submitBtnText}>Register & Switch</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

/* ── Reusable Components ────────────────────────────────────────── */
function ListItem({ icon, color, bg, title, sub, onPress, last }: any) {
  return (
    <TouchableOpacity style={[st.listItem, last && { borderBottomWidth: 0 }]} onPress={onPress}>
      <View style={[st.listIcon, { backgroundColor: bg }]}><Ionicons name={icon} size={18} color={color} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: C.textMut, fontSize: 12, marginTop: 1 }}>{sub}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.textMut} />
    </TouchableOpacity>
  );
}

function FormField({ icon, iconColor, label, value, onChange, editable = true, keyboardType }: any) {
  return (
    <View style={st.fieldRow}>
      <View style={st.fieldIcon}><Ionicons name={icon} size={15} color={iconColor || '#FFF'} /></View>
      <View style={{ flex: 1 }}>
        <Text style={st.fieldLabel}>{label}</Text>
        {editable && onChange ? (
          <TextInput style={st.fieldInput} value={value} onChangeText={onChange} placeholderTextColor={C.textDis} keyboardType={keyboardType} />
        ) : (
          <Text style={[st.fieldText, { color: C.textMut }]}>{value}</Text>
        )}
      </View>
    </View>
  );
}

function FormInput({ icon, label, value, placeholder, editable = true, secureTextEntry }: any) {
  return (
    <View style={{ marginBottom: 18 }}>
      <Text style={st.inputLabel}>{label}</Text>
      <View style={st.inputBox}>
        <Ionicons name={icon} size={18} color={C.textMut} style={{ marginRight: 14 }} />
        <TextInput style={{ flex: 1, color: '#FFF', fontSize: 14, fontWeight: '600' }} value={value} placeholder={placeholder} placeholderTextColor={C.textDis} editable={editable} secureTextEntry={secureTextEntry} />
      </View>
    </View>
  );
}

function AlertRow({ title, sub, value, onToggle }: any) {
  return (
    <View style={st.alertCard}>
      <View style={{ flex: 1 }}><Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600', marginBottom: 2 }}>{title}</Text><Text style={{ color: C.textMut, fontSize: 12 }}>{sub}</Text></View>
      <Switch value={value} onValueChange={onToggle} trackColor={{ false: '#333', true: C.accent }} thumbColor="#FFF" />
    </View>
  );
}

/* ── Styles ─────────────────────────────────────────────────────── */
const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, height: 56 },
  backBtn: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.card, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: '#FFF', fontSize: 17, fontWeight: '700' },
  scroll: { padding: 20, paddingBottom: 40 },

  avatarSection: { alignItems: 'center', marginTop: 8, marginBottom: 28 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center', position: 'relative' },
  avatarText: { color: '#FFF', fontSize: 36, fontWeight: '800' },
  onlineDot: { position: 'absolute', bottom: 4, right: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: C.success, borderWidth: 3, borderColor: C.bg },
  profileName: { color: '#FFF', fontSize: 22, fontWeight: '800', marginTop: 14 },
  profileEmail: { color: C.textSec, fontSize: 13, marginTop: 3 },
  roleBadge: { marginTop: 10, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, borderWidth: 1, borderColor: C.accent },
  roleBadgeText: { color: C.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  statCard: { flex: 1, backgroundColor: C.card, borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  statVal: { color: '#FFF', fontSize: 17, fontWeight: '800', marginTop: 6, marginBottom: 2 },
  statLbl: { color: C.textMut, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

  sectionLabel: { color: '#FFF', fontSize: 15, fontWeight: '700', marginBottom: 12 },
  listBox: { backgroundColor: C.card, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  listItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.border },
  listIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 14 },

  switchBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.infoSoft, borderRadius: 16, paddingVertical: 16, marginTop: 28, borderWidth: 1, borderColor: 'rgba(59,130,246,0.2)' },
  switchText: { color: C.info, fontSize: 15, fontWeight: '700' },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.errorSoft, borderRadius: 16, paddingVertical: 16, marginTop: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.2)' },
  signOutText: { color: C.error, fontSize: 15, fontWeight: '700' },

  formSection: { color: C.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 14, textTransform: 'uppercase' },
  formCard: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  fieldIcon: { width: 30, height: 30, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  fieldLabel: { color: C.accent, fontSize: 10, fontWeight: '800', marginBottom: 3, textTransform: 'uppercase' },
  fieldText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  fieldInput: { color: '#FFF', fontSize: 15, fontWeight: '600', padding: 0, margin: 0, height: 22 },
  divider: { height: 1, backgroundColor: C.border, marginHorizontal: 16 },

  submitBtn: { backgroundColor: C.accent, borderRadius: 16, paddingVertical: 16, marginTop: 36, alignItems: 'center' },
  submitBtnText: { color: '#FFF', fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },

  inputLabel: { color: C.accent, fontSize: 10, fontWeight: '800', marginBottom: 7, textTransform: 'uppercase' },
  inputBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, paddingHorizontal: 16, height: 52, borderWidth: 1, borderColor: C.border },

  verifiedCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.successSoft, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)' },
  shieldBox: { width: 38, height: 38, borderRadius: 10, backgroundColor: C.success, justifyContent: 'center', alignItems: 'center' },
  checkCircle: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.success, justifyContent: 'center', alignItems: 'center' },

  legalText: { color: C.textSec, fontSize: 14, lineHeight: 22, marginBottom: 18 },
  legalItem: { color: '#FFF', fontSize: 14, lineHeight: 22, marginBottom: 14 },

  alertCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: C.border },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: C.elevated, borderTopLeftRadius: 32, borderTopRightRadius: 32, padding: 28, borderWidth: 1, borderColor: C.border },
  receiptHeader: { alignItems: 'center', marginBottom: 10 },
  receiptAvatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accentSoft, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  receiptTitle: { color: '#FFF', fontSize: 20, fontWeight: '900' },
  receiptSub: { color: C.textMut, fontSize: 13, marginTop: 2 },
  receiptRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  receiptLabel: { color: C.textSec, fontSize: 13, fontWeight: '600' },
  receiptVal: { color: '#FFF', fontSize: 14, fontWeight: '800', textAlign: 'right' },
});
