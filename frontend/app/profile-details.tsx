import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, ActivityIndicator, Alert, Dimensions, Switch, Image } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';
import apiClient from '../api/client';

const { width } = Dimensions.get('window');

export default function ProfileDetails() {
  const router = useRouter();
  const { type } = useLocalSearchParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  // SHARED STATE
  const [formData, setFormData] = useState<any>({
    // Personal
    name: '', email: '', phone: '', address: '', dob: '', gender: '',
    // Payouts
    bankName: '', accountNo: '', ifsc: '', upiId: '', paypalEmail: '',
    // Notifications
    push: true, emailNotif: true, sms: false, marketing: false,
    // Security
    oldPass: '', newPass: '', confirmPass: '',
    // Verification
    idType: 'Driver License', idNumber: '', idUploaded: true
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const res = await apiClient.get('/auth/profile');
      if (res.data.success) {
        const u = res.data.data.user;
        setFormData((prev: any) => ({
          ...prev,
          name: u.full_name || u.name,
          email: u.email,
          phone: u.phone || ''
        }));
      }
    } catch (e) {
      console.log('Error loading details');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (type === 'security' && formData.newPass !== formData.confirmPass) {
      return Alert.alert('Error', 'New passwords do not match');
    }

    setSaving(true);
    try {
      if (type === 'personal') {
        await apiClient.put('/auth/profile', { name: formData.name, phone: formData.phone });
      }
      // Save the updates
      Alert.alert('Success', `${type.toString().charAt(0).toUpperCase() + type.toString().slice(1)} updated successfully.`);
      router.back();
    } catch (e) {
      Alert.alert('Error', 'Failed to save updates.');
    } finally {
      setSaving(false);
    }
  };

  const renderPersonal = () => (
    <View style={styles.formContainer}>
      <Text style={styles.sectionTitle}>Identity & Contact</Text>
      <InfoInput label="FULL NAME" value={formData.name} onChange={(v: string) => setFormData({...formData, name: v})} icon="👤" />
      <InfoInput label="EMAIL ADDRESS" value={formData.email} editable={false} icon="✉️" />
      <InfoInput label="PHONE NUMBER" value={formData.phone} onChange={(v: string) => setFormData({...formData, phone: v})} keyboardType="phone-pad" icon="📞" />
      
      <Text style={[styles.sectionTitle, { marginTop: 30 }]}>Basic Human Details</Text>
      <InfoInput label="RESIDENTIAL ADDRESS" value={formData.address} onChange={(v: string) => setFormData({...formData, address: v})} icon="🏠" />
      <InfoInput label="DATE OF BIRTH" value={formData.dob} onChange={(v: string) => setFormData({...formData, dob: v})} icon="📅" />
      <InfoInput label="GENDER" value={formData.gender} onChange={(v: string) => setFormData({...formData, gender: v})} icon="⚧" />
    </View>
  );

  const renderPayouts = () => (
    <View style={styles.formContainer}>
      <Text style={styles.sectionTitle}>Bank Transfer</Text>
      <InfoInput label="BANK NAME" value={formData.bankName} onChange={(v: string) => setFormData({...formData, bankName: v})} placeholder="HDFC, Chase, etc." icon="🏦" />
      <InfoInput label="ACCOUNT NUMBER" value={formData.accountNo} onChange={(v: string) => setFormData({...formData, accountNo: v})} keyboardType="numeric" icon="🔢" />
      <InfoInput label="IFSC / ROUTING" value={formData.ifsc} onChange={(v: string) => setFormData({...formData, ifsc: v})} icon="🎫" />

      <Text style={[styles.sectionTitle, { marginTop: 30 }]}>Digital Wallets</Text>
      <InfoInput label="UPI ID (VPA)" value={formData.upiId} onChange={(v: string) => setFormData({...formData, upiId: v})} placeholder="user@upi" icon="💸" />
      <InfoInput label="PAYPAL" value={formData.paypalEmail} onChange={(v: string) => setFormData({...formData, paypalEmail: v})} keyboardType="email-address" icon="🅿️" />

      <TouchableOpacity style={styles.stripeConnectBtn} onPress={() => Alert.alert('Stripe', 'Opening secure connection...')}>
        <Text style={{ color: '#FFF', fontSize: 20, marginRight: 10 }}>💳</Text>
        <Text style={{ color: '#FFF', fontWeight: '800' }}>Connect Stripe Account</Text>
      </TouchableOpacity>
    </View>
  );

  const renderNotifications = () => (
    <View style={styles.formContainer}>
      <Text style={styles.sectionTitle}>Alert Channels</Text>
      <ToggleRow label="Push Notifications" sub="Real-time booking alerts" value={formData.push} onToggle={(v: boolean) => setFormData({...formData, push: v})} />
      <ToggleRow label="Email Summaries" sub="Daily earnings reports" value={formData.emailNotif} onToggle={(v: boolean) => setFormData({...formData, emailNotif: v})} />
      <ToggleRow label="SMS Critical Alerts" sub="Emergency spot updates" value={formData.sms} onToggle={(v: boolean) => setFormData({...formData, sms: v})} />
    </View>
  );

  const renderVerification = () => (
    <View style={styles.formContainer}>
      <Text style={styles.sectionTitle}>Identity Verification</Text>
      <View style={styles.verifiedStatusCard}>
        <View style={styles.statusCircle}><Text style={{ fontSize: 24 }}>🛡️</Text></View>
        <View style={{ flex: 1, marginLeft: 15 }}>
          <Text style={styles.statusTitle}>ID Verified</Text>
          <Text style={styles.statusSub}>Your identity was confirmed on April 12, 2026.</Text>
        </View>
        <View style={styles.checkBadge}><Text style={{ color: '#FFF', fontWeight: '900' }}>✓</Text></View>
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 30 }]}>Verification Details</Text>
      <InfoInput label="ID TYPE" value={formData.idType} editable={false} icon="🪪" />
      <InfoInput label="DOCUMENT NUMBER" value="•••• •••• 8821" editable={false} icon="🔢" />

      <TouchableOpacity style={styles.reverifyBtn} onPress={() => Alert.alert('Update ID', 'You are already verified. Contact support to change your identity documents.')}>
        <Text style={styles.reverifyText}>Update ID Documents</Text>
      </TouchableOpacity>
    </View>
  );

  const renderSecurity = () => (
    <View style={styles.formContainer}>
      <Text style={styles.sectionTitle}>Login Security</Text>
      <InfoInput label="CURRENT PASSWORD" value={formData.oldPass} onChange={(v: string) => setFormData({...formData, oldPass: v})} secureTextEntry icon="🔒" />
      <InfoInput label="NEW PASSWORD" value={formData.newPass} onChange={(v: string) => setFormData({...formData, newPass: v})} secureTextEntry icon="🔑" />
      <InfoInput label="CONFIRM NEW PASSWORD" value={formData.confirmPass} onChange={(v: string) => setFormData({...formData, confirmPass: v})} secureTextEntry icon="🔁" />
      
      <View style={[styles.toggleRow, { marginTop: 20 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.toggleLabel}>Two-Factor Auth</Text>
          <Text style={styles.toggleSub}>Secure your account with SMS codes</Text>
        </View>
        <Switch value={formData.twoFactor} onValueChange={(v) => setFormData({...formData, twoFactor: v})} trackColor={{ false: '#334155', true: BlueprintColors.primaryAccent }} />
      </View>
    </View>
  );

  const renderTerms = () => (
    <ScrollView style={styles.termsContainer} showsVerticalScrollIndicator={false}>
      <Text style={styles.termsHeader}>ParkStop Spotter Terms</Text>
      <Text style={styles.termsBody}>
        By listing your property on ParkStop, you agree to provide accurate location data and ensure the safety of parked vehicles. {"\n\n"}
        1. Revenue Share: ParkStop takes a 15% platform fee on all successful bookings. {"\n\n"}
        2. Responsibilities: You are responsible for ensuring that the parking spot is clear and accessible during the reserved hours. {"\n\n"}
        3. Payouts: Earnings are processed every Friday for the previous week's completed sessions. {"\n\n"}
        4. Cancellations: Repeated cancellations of confirmed bookings may lead to account suspension. {"\n\n"}
        5. Liability: You agree to indemnify ParkStop against any claims arising from the use of your private property for parking. {"\n\n"}
        Please read our full Privacy Policy on our website.
      </Text>
    </ScrollView>
  );

  const renderContent = () => {
    switch(type) {
      case 'personal': return renderPersonal();
      case 'payout': return renderPayouts();
      case 'notifications': return renderNotifications();
      case 'verification': return renderVerification();
      case 'security': return renderSecurity();
      case 'terms': return renderTerms();
      default: return <View style={styles.placeholderContainer}><Text style={{ color: '#FFF' }}>Feature coming soon...</Text></View>;
    }
  };

  return (
    <SafeAreaView style={styles.mainContainer}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backArrow}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {type === 'personal' ? 'Identity' : type === 'payout' ? 'Payouts' : type === 'verification' ? 'ID Status' : type === 'security' ? 'Security' : type === 'terms' ? 'Legal' : 'Alerts'}
        </Text>
        <TouchableOpacity onPress={handleSave} disabled={saving || type === 'terms'} style={[styles.saveBtn, type === 'terms' && { opacity: 0 }]}>
          {saving ? <ActivityIndicator color={BlueprintColors.primaryAccent} size="small" /> : <Text style={styles.saveText}>Update</Text>}
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator style={{ marginTop: 100 }} color={BlueprintColors.primaryAccent} /> : renderContent()}
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoInput({ label, value, onChange, editable = true, keyboardType = 'default', icon, placeholder, secureTextEntry }: any) {
  return (
    <View style={styles.inputWrapper}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={[styles.inputBox, !editable && { opacity: 0.5 }]}>
        <Text style={{ fontSize: 18, marginRight: 12 }}>{icon}</Text>
        <TextInput 
          style={styles.textInput}
          value={value}
          onChangeText={onChange}
          editable={editable}
          keyboardType={keyboardType}
          placeholder={placeholder}
          secureTextEntry={secureTextEntry}
          placeholderTextColor="rgba(255,255,255,0.1)"
        />
      </View>
    </View>
  );
}

function ToggleRow({ label, sub, value, onToggle }: any) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleSub}>{sub}</Text>
      </View>
      <Switch 
        value={value} 
        onValueChange={onToggle} 
        trackColor={{ false: '#334155', true: BlueprintColors.primaryAccent }} 
        thumbColor="#FFF"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mainContainer: { flex: 1, backgroundColor: BlueprintColors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '800' },
  backBtn: { width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center' },
  backArrow: { color: '#FFF', fontSize: 28, fontWeight: '300', marginTop: -4 },
  saveBtn: { backgroundColor: 'rgba(255,107,44,0.1)', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 10 },
  saveText: { color: BlueprintColors.primaryAccent, fontSize: 14, fontWeight: '900' },
  formContainer: { padding: 20 },
  sectionTitle: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 20, textTransform: 'uppercase' },
  inputWrapper: { marginBottom: 20 },
  inputLabel: { color: BlueprintColors.primaryAccent, fontSize: 10, fontWeight: '800', marginBottom: 8, marginLeft: 4 },
  inputBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 18, paddingHorizontal: 15, height: 58, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  textInput: { flex: 1, color: '#FFF', fontSize: 16, fontWeight: '600' },
  stripeConnectBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#6366F1', padding: 18, borderRadius: 18, marginTop: 10, justifyContent: 'center' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.02)', padding: 18, borderRadius: 20, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  toggleLabel: { color: '#FFF', fontSize: 16, fontWeight: '700', marginBottom: 2 },
  toggleSub: { color: 'rgba(255,255,255,0.3)', fontSize: 12, fontWeight: '500' },
  placeholderContainer: { flex: 1, alignItems: 'center', marginTop: 100 },
  
  // VERIFICATION STYLES
  verifiedStatusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(34, 197, 94, 0.05)', padding: 20, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(34, 197, 94, 0.1)' },
  statusCircle: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(34, 197, 94, 0.1)', justifyContent: 'center', alignItems: 'center' },
  statusTitle: { color: '#FFF', fontSize: 18, fontWeight: '800' },
  statusSub: { color: 'rgba(255,255,255,0.4)', fontSize: 13, marginTop: 4 },
  checkBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#22C55E', justifyContent: 'center', alignItems: 'center' },
  reverifyBtn: { marginTop: 30, alignItems: 'center', padding: 15 },
  reverifyText: { color: 'rgba(255,255,255,0.3)', fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },

  // TERMS STYLES
  termsContainer: { padding: 20, marginBottom: 60 },
  termsHeader: { color: '#FFF', fontSize: 24, fontWeight: '900', marginBottom: 20 },
  termsBody: { color: 'rgba(255,255,255,0.6)', fontSize: 15, lineHeight: 24 }
});
