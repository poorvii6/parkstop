import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
  ScrollView, Animated
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import { SC } from '../../constants/SpotterTheme';

export default function PayoutSetupScreen() {
  const router = useRouter();
  const [payoutType, setPayoutType] = useState<'upi' | 'bank'>('upi');
  const [upiId, setUpiId] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [accountName, setAccountName] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [isSetup, setIsSetup] = useState(false);
  const [existingData, setExistingData] = useState<any>(null);

  // Check existing payout setup
  useEffect(() => {
    checkPayoutStatus();
  }, []);

  const checkPayoutStatus = async () => {
    try {
      const res = await apiClient.get('/payouts/account-status');
      if (res.data?.success) {
        const data = res.data.data;
        setIsSetup(data.is_setup);
        setExistingData(data);
        if (data.upi_id) {
          setPayoutType('upi');
          setUpiId(data.upi_id);
        } else if (data.bank_account) {
          setPayoutType('bank');
          setAccountName(data.bank_account_name || '');
          setIfsc(data.bank_ifsc || '');
        }
      }
    } catch (e) {
      console.log('Error checking payout status:', e);
    } finally {
      setChecking(false);
    }
  };

  const handleSubmit = async () => {
    if (payoutType === 'upi') {
      if (!upiId || !upiId.includes('@')) {
        return Alert.alert('Invalid UPI ID', 'Enter a valid UPI ID like name@paytm or number@upi');
      }
    } else {
      if (!accountNumber || !ifsc || !accountName) {
        return Alert.alert('Missing Details', 'Please fill in all bank account fields');
      }
      if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifsc)) {
        return Alert.alert('Invalid IFSC', 'Please enter a valid 11-character IFSC code');
      }
    }

    setLoading(true);
    try {
      const payload: any = { type: payoutType };
      if (payoutType === 'upi') {
        payload.upi_id = upiId.trim();
      } else {
        payload.account_number = accountNumber.trim();
        payload.ifsc = ifsc.trim().toUpperCase();
        payload.name = accountName.trim();
      }

      const endpoint = isSetup ? '/payouts/update-details' : '/payouts/setup-account';
      const method = isSetup ? 'put' : 'post';

      const res = await apiClient[method](endpoint, payload);

      if (res.data?.success) {
        Alert.alert(
          '✅ Payout Account Ready!',
          `Your ${payoutType === 'upi' ? 'UPI' : 'bank'} account has been ${isSetup ? 'updated' : 'linked'}. You'll receive earnings automatically after each booking.`,
          [{ text: 'Back to Dashboard', onPress: () => router.back() }]
        );
      }
    } catch (error: any) {
      const msg = error.response?.data?.message || error.message || 'Something went wrong';
      Alert.alert('Setup Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={SC.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Payout Setup</Text>
          <View style={{ width: 40 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          {/* Status Banner */}
          {isSetup && (
            <View style={styles.statusBanner}>
              <Ionicons name="checkmark-circle" size={20} color={SC.success} />
              <Text style={styles.statusText}>
                Payout account active via {existingData?.payout_mode?.toUpperCase()}
              </Text>
            </View>
          )}

          {/* Info Card */}
          <View style={styles.infoCard}>
            <Ionicons name="information-circle" size={20} color={SC.info} />
            <Text style={styles.infoText}>
              Add your UPI ID or bank account to receive earnings automatically when a booking completes. ParkStop pays you 80% of each booking.
            </Text>
          </View>

          {/* Payout Type Selector */}
          <Text style={styles.sectionLabel}>PAYOUT METHOD</Text>
          <View style={styles.typeSelector}>
            <TouchableOpacity
              style={[styles.typeOption, payoutType === 'upi' && styles.typeOptionActive]}
              onPress={() => setPayoutType('upi')}
            >
              <Ionicons
                name="flash"
                size={18}
                color={payoutType === 'upi' ? '#FFF' : SC.textMuted}
              />
              <Text style={[styles.typeText, payoutType === 'upi' && styles.typeTextActive]}>
                UPI
              </Text>
              <Text style={[styles.typeSub, payoutType === 'upi' && { color: 'rgba(255,255,255,0.6)' }]}>
                Instant
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.typeOption, payoutType === 'bank' && styles.typeOptionActive]}
              onPress={() => setPayoutType('bank')}
            >
              <Ionicons
                name="business"
                size={18}
                color={payoutType === 'bank' ? '#FFF' : SC.textMuted}
              />
              <Text style={[styles.typeText, payoutType === 'bank' && styles.typeTextActive]}>
                Bank Account
              </Text>
              <Text style={[styles.typeSub, payoutType === 'bank' && { color: 'rgba(255,255,255,0.6)' }]}>
                IMPS/NEFT
              </Text>
            </TouchableOpacity>
          </View>

          {/* UPI Form */}
          {payoutType === 'upi' && (
            <View style={styles.formSection}>
              <Text style={styles.inputLabel}>UPI ID</Text>
              <TextInput
                style={styles.input}
                placeholder="yourname@paytm"
                placeholderTextColor={SC.textMuted}
                value={upiId}
                onChangeText={setUpiId}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <Text style={styles.helperText}>
                Examples: 9876543210@upi, name@paytm, name@ybl
              </Text>
            </View>
          )}

          {/* Bank Account Form */}
          {payoutType === 'bank' && (
            <View style={styles.formSection}>
              <Text style={styles.inputLabel}>ACCOUNT HOLDER NAME</Text>
              <TextInput
                style={styles.input}
                placeholder="As per bank records"
                placeholderTextColor={SC.textMuted}
                value={accountName}
                onChangeText={setAccountName}
              />

              <Text style={styles.inputLabel}>ACCOUNT NUMBER</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter account number"
                placeholderTextColor={SC.textMuted}
                value={accountNumber}
                onChangeText={setAccountNumber}
                keyboardType="numeric"
                secureTextEntry
              />

              <Text style={styles.inputLabel}>IFSC CODE</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. SBIN0001234"
                placeholderTextColor={SC.textMuted}
                value={ifsc}
                onChangeText={(text) => setIfsc(text.toUpperCase())}
                autoCapitalize="characters"
                maxLength={11}
              />
              <Text style={styles.helperText}>
                11-character code found on your cheque book or bank's website
              </Text>
            </View>
          )}

          {/* Balance Display */}
          {existingData?.balance !== undefined && (
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>CURRENT BALANCE</Text>
              <Text style={styles.balanceValue}>₹{Number(existingData.balance).toFixed(2)}</Text>
              <Text style={styles.balanceSub}>
                Earnings from completed bookings
              </Text>
            </View>
          )}

          {/* Submit Button */}
          <TouchableOpacity
            style={[styles.submitBtn, loading && { opacity: 0.6 }]}
            onPress={handleSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <>
                <Ionicons name="shield-checkmark" size={20} color="#FFF" />
                <Text style={styles.submitText}>
                  {isSetup ? 'Update Payout Account' : 'Link Payout Account'}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {/* Security Note */}
          <View style={styles.securityNote}>
            <Ionicons name="lock-closed" size={14} color={SC.textMuted} />
            <Text style={styles.securityText}>
              Your details are encrypted and stored securely. ParkStop uses Razorpay's banking infrastructure for all payouts.
            </Text>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: SC.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: SC.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFF',
    letterSpacing: -0.5,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: SC.successSoft,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.2)',
  },
  statusText: {
    color: SC.success,
    fontSize: 14,
    fontWeight: '700',
    flex: 1,
  },
  infoCard: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: SC.infoSoft,
    borderRadius: 14,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.15)',
  },
  infoText: {
    color: SC.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    flex: 1,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: SC.textMuted,
    letterSpacing: 1.5,
    marginBottom: 10,
  },
  typeSelector: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 28,
  },
  typeOption: {
    flex: 1,
    backgroundColor: SC.bgCard,
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderColor: SC.border,
  },
  typeOptionActive: {
    backgroundColor: SC.accent,
    borderColor: SC.accent,
  },
  typeText: {
    fontSize: 14,
    fontWeight: '700',
    color: SC.textSecondary,
  },
  typeTextActive: {
    color: '#FFF',
  },
  typeSub: {
    fontSize: 11,
    color: SC.textMuted,
    fontWeight: '600',
  },
  formSection: {
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: SC.textMuted,
    letterSpacing: 1,
    marginBottom: 8,
  },
  input: {
    backgroundColor: SC.bgElevated,
    borderWidth: 1,
    borderColor: SC.border,
    borderRadius: 14,
    padding: 16,
    color: '#FFF',
    fontSize: 16,
    marginBottom: 12,
  },
  helperText: {
    fontSize: 12,
    color: SC.textMuted,
    marginTop: -4,
    marginBottom: 16,
  },
  balanceCard: {
    backgroundColor: SC.bgCard,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: SC.border,
  },
  balanceLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: SC.textMuted,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  balanceValue: {
    fontSize: 32,
    fontWeight: '900',
    color: SC.success,
    letterSpacing: -1,
  },
  balanceSub: {
    fontSize: 12,
    color: SC.textMuted,
    marginTop: 4,
  },
  submitBtn: {
    backgroundColor: SC.accent,
    borderRadius: 16,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 16,
    shadowColor: SC.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  submitText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '800',
  },
  securityNote: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    paddingHorizontal: 4,
  },
  securityText: {
    fontSize: 11,
    color: SC.textMuted,
    lineHeight: 16,
    flex: 1,
  },
});
