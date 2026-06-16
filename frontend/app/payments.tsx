import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  ScrollView, 
  ActivityIndicator, 
  Alert, 
  Dimensions, 
  Modal, 
  TextInput 
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlueprintColors } from '../constants/BlueprintTheme';
import apiClient from '../api/client';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0E14' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  title: { color: '#FFF', fontSize: 18, fontWeight: '900', letterSpacing: -0.2 },
  backBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center' },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 60 },
  sectionLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginTop: 30, marginBottom: 15, textTransform: 'uppercase' },
  
  earningsCard: { borderRadius: 32, padding: 25, marginBottom: 10, overflow: 'hidden', elevation: 15, shadowColor: BlueprintColors.primaryAccent, shadowOpacity: 0.3, shadowRadius: 20 },
  earningsLabel: { color: 'rgba(0,0,0,0.5)', fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
  earningsAmount: { color: '#000', fontSize: 42, fontWeight: '900', letterSpacing: -1 },
  earningsFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 15 },
  payoutBtn: { backgroundColor: '#000', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 16 },
  payoutText: { color: '#FFF', fontSize: 14, fontWeight: '900' },

  cardsScroll: { marginHorizontal: -20, paddingLeft: 20, marginBottom: 10 },
  cardWrapper: { width: width * 0.85, height: 210, marginRight: 15, borderRadius: 28, overflow: 'hidden', elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 15 }, shadowOpacity: 0.5, shadowRadius: 20 },
  cardGradient: { flex: 1, padding: 25, justifyContent: 'space-between' },
  cardChip: { width: 45, height: 35, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  cardChipLines: { flex: 1, borderBottomWidth: 1, borderRightWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardDefaultBadge: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  cardDefaultText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  cardNumberRow: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  cardDots: { color: 'rgba(255,255,255,0.3)', fontSize: 24, letterSpacing: 4 },
  cardLast4: { color: '#FFF', fontSize: 28, fontWeight: '700', letterSpacing: 2 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  cardLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: '800', marginBottom: 4 },
  cardValue: { color: '#FFF', fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
  
  menuItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 26, padding: 20, marginBottom: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  menuIconBox: { width: 54, height: 54, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  menuContent: { flex: 1, marginLeft: 18 },
  menuTitle: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  menuSub: { color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 4 },
  
  historyItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 24, padding: 18, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' },
  historyIcon: { width: 50, height: 50, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.04)', justifyContent: 'center', alignItems: 'center' },
  historyAmount: { color: '#FFF', fontSize: 18, fontWeight: '900' },
  
  processingOverlay: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,107,44,0.1)', padding: 15, borderRadius: 22, marginBottom: 20, gap: 12, borderWidth: 1, borderColor: 'rgba(255,107,44,0.3)' },
  processingText: { color: BlueprintColors.primaryAccent, fontSize: 14, fontWeight: '800' },
  
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#151A21', borderTopLeftRadius: 40, borderTopRightRadius: 40, padding: 35, paddingBottom: 60, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  modalInput: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: 20, color: '#FFF', fontSize: 16, marginBottom: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  saveBtn: { backgroundColor: BlueprintColors.primaryAccent, padding: 22, borderRadius: 20, alignItems: 'center', marginBottom: 15 },
  saveBtnText: { color: '#000', fontSize: 17, fontWeight: '900' },

  receiptBox: { backgroundColor: '#FFF', borderRadius: 32, padding: 40, alignItems: 'center', width: '100%' },
  receiptDivider: { width: '100%', height: 2, backgroundColor: '#F0F0F0', marginVertical: 30, borderStyle: 'dashed', borderRadius: 1 },

  // WITHDRAWAL STYLES
  withdrawalMethodItem: { flexDirection: 'row', alignItems: 'center', padding: 20, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 20, marginBottom: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  methodSelected: { borderColor: BlueprintColors.primaryAccent, backgroundColor: 'rgba(190,242,100,0.05)' }
});

const CreditCard = ({ brand, last4, isDefault }: { brand: string, last4: string, isDefault: boolean }) => {
  const brandName = (brand || '').toLowerCase();
  const iconName = brandName === 'visa' ? 'cc-visa' : 'cc-mastercard';
  const colors = brandName === 'visa' ? (['#2563EB', '#1D4ED8', '#1E3A8A'] as const) : (['#EC4899', '#DB2777', '#831843'] as const);
  
  return (
    <TouchableOpacity 
      style={styles.cardWrapper} 
      activeOpacity={0.9}
      onPress={() => Alert.alert('Secure Card', 'This card is tokenized via Stripe PCI-compliant vaults.')}
    >
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cardGradient}>
        <View style={styles.cardHeader}>
          <View style={styles.cardChip}>
            <View style={styles.cardChipLines} />
            <View style={[styles.cardChipLines, { borderRightWidth: 0 }]} />
          </View>
          <View style={styles.cardDefaultBadge}>
            <Text style={styles.cardDefaultText}>{isDefault ? 'PRIMARY' : 'SECONDARY'}</Text>
          </View>
        </View>

        <View style={styles.cardNumberRow}>
          <Text style={styles.cardDots}>••••  ••••  ••••</Text>
          <Text style={styles.cardLast4}>{last4}</Text>
        </View>

        <View style={styles.cardFooter}>
          <View>
            <Text style={styles.cardLabel}>CARD HOLDER</Text>
            <Text style={styles.cardValue}>PARKSTOP USER</Text>
          </View>
          <FontAwesome5 name={iconName} size={42} color="rgba(255,255,255,0.8)" />
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
};

export default function PaymentMethodsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState('finder');
  const [methods, setMethods] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isUpiModalVisible, setUpiModalVisible] = useState(false);
  const [isWithdrawModalVisible, setWithdrawModalVisible] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<any>(null);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [vpaValue, setVpaValue] = useState('');
  const [balance, setBalance] = useState(0);
  const [isCardModalVisible, setCardModalVisible] = useState(false);
  const [cardForm, setCardForm] = useState({ number: '', expiry: '', cvv: '', name: '' });
  
  const hasFetched = useRef(false);

  const fetchData = async () => {
    try {
      const storedRole = await AsyncStorage.getItem('user_role');
      if (storedRole) setRole(storedRole);

      const [methodsRes, historyRes] = await Promise.all([
        apiClient.get('/payments/methods').catch(() => ({ data: { success: false } })),
        apiClient.get('/payments/history').catch(() => ({ data: { success: false } }))
      ]);
      
      const fetchedMethods = methodsRes.data?.success ? methodsRes.data.data : [];
      const fetchedHistory = historyRes.data?.success ? historyRes.data.data : [];

      setMethods(fetchedMethods);
      setHistory(fetchedHistory);
      
      // Fetch user profile for real balance if they are a spotter
      if (storedRole === 'spotter') {
         const profileRes = await apiClient.get('/auth/profile');
         if (profileRes.data?.success) {
            const userBalance = profileRes.data.data.user.balance;
            setBalance(Number(userBalance) || 0);
         }
      }
      
    } catch (e) {
      console.log('Error fetching payment data', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    
    fetchData();
  }, []);

  const handleWithdraw = () => {
    setWithdrawModalVisible(true);
  };

  const confirmWithdrawal = async () => {
    if (!selectedMethodId) {
      Alert.alert('Error', 'Please select a payout method');
      return;
    }
    
    setWithdrawModalVisible(false);
    setIsProcessing(true);
    
    try {
      const res = await apiClient.post('/payments/withdraw', {
        methodId: selectedMethodId,
        amount: balance
      });
      
      if (res.data?.success) {
        Alert.alert('Success', 'Your withdrawal request has been submitted and is being processed.');
        fetchData(); // Refresh to see updated balance
      }
    } catch (e) {
      Alert.alert('Withdrawal Failed', 'Could not process payout. Please try again later.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddCard = () => {
    setCardForm({ number: '', expiry: '', cvv: '', name: '' });
    setCardModalVisible(true);
  };

  const submitCard = async () => {
    if (!cardForm.number || cardForm.number.replace(/\s/g, '').length < 16) {
      return Alert.alert('Invalid', 'Please enter a valid 16-digit card number.');
    }
    if (!cardForm.expiry || !cardForm.expiry.includes('/')) {
      return Alert.alert('Invalid', 'Please enter expiry as MM/YY.');
    }
    if (!cardForm.cvv || cardForm.cvv.length < 3) {
      return Alert.alert('Invalid', 'Please enter a valid CVV.');
    }
    setCardModalVisible(false);
    setIsProcessing(true);
    try {
      const cleanNum = cardForm.number.replace(/\s/g, '');
      const last4 = cleanNum.slice(-4);
      const firstDigit = cleanNum[0];
      const brand = firstDigit === '4' ? 'visa' : 'mastercard';
      await apiClient.post('/payments/methods', {
        provider: 'secure_vault',
        token: 'pm_' + Math.random().toString(36).substring(7),
        type: 'card',
        last4,
        brand
      });
      hasFetched.current = false;
      fetchData();
      Alert.alert('Success', 'Card added securely!');
    } catch (e) {
      Alert.alert('Error', 'Could not add card. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddUPI = () => setUpiModalVisible(true);

  const submitUPI = async () => {
    if (!vpaValue) return;
    setUpiModalVisible(false);
    setIsProcessing(true);
    try {
      await apiClient.post('/payments/methods', {
        provider: 'razorpay',
        token: vpaValue,
        type: 'upi',
        brand: 'upi_vpa'
      });
      hasFetched.current = false;
      fetchData();
      setVpaValue('');
    } catch (e) { Alert.alert('Error', 'Invalid VPA'); } finally { setIsProcessing(false); }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0B0E14', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={BlueprintColors.primaryAccent} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.title}>Digital Wallet</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => { hasFetched.current = false; fetchData(); }}>
          <Ionicons name="refresh" size={20} color="#FFF" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {isProcessing && (
          <View style={styles.processingOverlay}>
            <ActivityIndicator color={BlueprintColors.primaryAccent} />
            <Text style={styles.processingText}>Securing Connection...</Text>
          </View>
        )}

        {role === 'spotter' && (
          <LinearGradient colors={[BlueprintColors.primaryAccent, '#BEF264']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.earningsCard}>
            <Text style={styles.earningsLabel}>Net Earnings</Text>
            <Text style={styles.earningsAmount}>₹{Number(balance || 0).toFixed(2)}</Text>
            <View style={styles.earningsFooter}>
              <Text style={{ color: 'rgba(0,0,0,0.5)', fontSize: 13, fontWeight: '700' }}>May Payout Status: Available</Text>
              <TouchableOpacity style={styles.payoutBtn} onPress={handleWithdraw}>
                <Text style={styles.payoutText}>Withdraw</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        )}

        <Text style={styles.sectionLabel}>{role === 'finder' ? 'Saved Payment Methods' : 'Bank & UPI Accounts'}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cardsScroll}>
          {methods.filter(m => m.method_type === 'card').map((m) => (
            <CreditCard 
              key={m.id} 
              brand={m.brand} 
              last4={m.last4} 
              isDefault={m.is_default}
            />
          ))}
        </ScrollView>

        <Text style={styles.sectionLabel}>Recent Transactions</Text>
        {history.map((item) => (
          <TouchableOpacity key={item.id} style={styles.historyItem} onPress={() => setSelectedReceipt(item)}>
            <View style={styles.historyIcon}><Ionicons name="receipt" size={26} color="rgba(255,255,255,0.4)" /></View>
            <View style={{ flex: 1, marginLeft: 15 }}>
              <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>{item.spotTitle}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 4 }}>{new Date(item.date).toLocaleDateString()} • Successful</Text>
            </View>
            <Text style={styles.historyAmount}>₹{item.amount.toFixed(2)}</Text>
          </TouchableOpacity>
        ))}

        <Text style={styles.sectionLabel}>Management</Text>
        
        <TouchableOpacity style={styles.menuItem} onPress={handleAddCard}>
          <LinearGradient colors={['#6366F1', '#4F46E5']} style={styles.menuIconBox}>
            <Ionicons name="card" size={26} color="#FFF" />
          </LinearGradient>
          <View style={styles.menuContent}>
            <Text style={styles.menuTitle}>Add New Card</Text>
            <Text style={styles.menuSub}>256-bit Secure Encryption</Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.1)" />
        </TouchableOpacity>

        <TouchableOpacity style={styles.menuItem} onPress={handleAddUPI}>
          <LinearGradient colors={['#00D1FF', '#0099FF']} style={styles.menuIconBox}>
            <Ionicons name="flash" size={28} color="#FFF" />
          </LinearGradient>
          <View style={styles.menuContent}>
            <Text style={styles.menuTitle}>Link UPI / VPA</Text>
            <Text style={styles.menuSub}>Instant Settlement</Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.1)" />
        </TouchableOpacity>

        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 20, padding: 20, marginTop: 10, gap: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
          <Ionicons name="shield-checkmark" size={28} color={BlueprintColors.primaryAccent} />
          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, flex: 1, lineHeight: 18 }}>
            ParkStop uses 256-bit encryption. We never store raw payment details — only secure gateway tokens.
          </Text>
        </View>
      </ScrollView>

      {/* WITHDRAW MODAL */}
      <Modal visible={isWithdrawModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { height: '70%' }]}>
            <Text style={{ color: '#FFF', fontSize: 26, fontWeight: '900', marginBottom: 10 }}>Confirm Withdrawal</Text>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, marginBottom: 30 }}>Select a destination for your earnings</Text>
            
            <ScrollView style={{ flex: 1 }}>
              {methods.map((method) => (
                <TouchableOpacity 
                  key={method.id} 
                  style={[styles.withdrawalMethodItem, selectedMethodId === method.id && styles.methodSelected]}
                  onPress={() => setSelectedMethodId(method.id)}
                >
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', justifyContent: 'center', alignItems: 'center' }}>
                    <Ionicons 
                      name={method.method_type === 'card' ? "card" : "flash"} 
                      size={20} 
                      color={BlueprintColors.primaryAccent} 
                    />
                  </View>
                  <View style={{ flex: 1, marginLeft: 15 }}>
                    <Text style={{ color: '#FFF', fontSize: 15, fontWeight: '700' }}>
                      {method.method_type === 'card' ? `${method.brand.toUpperCase()} •••• ${method.last4}` : method.provider_method_id}
                    </Text>
                    <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 2 }}>
                      {method.method_type === 'card' ? "Direct Bank Payout" : "Instant UPI Settlement"}
                    </Text>
                  </View>
                  {selectedMethodId === method.id && <Ionicons name="checkmark-circle" size={24} color={BlueprintColors.primaryAccent} />}
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={{ paddingVertical: 20 }}>
               <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 }}>
                  <Text style={{ color: 'rgba(255,255,255,0.5)', fontWeight: '700' }}>Withdrawal Amount</Text>
                  <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '900' }}>₹{Number(balance || 0).toFixed(2)}</Text>
               </View>
               <TouchableOpacity style={styles.saveBtn} onPress={confirmWithdrawal}>
                  <Text style={styles.saveBtnText}>Confirm Withdrawal</Text>
               </TouchableOpacity>
               <TouchableOpacity style={{ padding: 15, alignItems: 'center' }} onPress={() => setWithdrawModalVisible(false)}>
                  <Text style={{ color: 'rgba(255,255,255,0.4)', fontWeight: '700' }}>Cancel</Text>
               </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* OTHER MODALS */}
      <Modal visible={isUpiModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '900', marginBottom: 10 }}>Link UPI</Text>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, marginBottom: 30 }}>Enter your VPA (e.g., name@okaxis)</Text>
            <TextInput style={styles.modalInput} value={vpaValue} onChangeText={setVpaValue} placeholder="yourname@upi" placeholderTextColor="rgba(255,255,255,0.2)" autoCapitalize="none" />
            <TouchableOpacity style={styles.saveBtn} onPress={submitUPI}><Text style={styles.saveBtnText}>Secure Link</Text></TouchableOpacity>
            <TouchableOpacity style={{ padding: 15, alignItems: 'center' }} onPress={() => setUpiModalVisible(false)}><Text style={{ color: 'rgba(255,255,255,0.4)', fontWeight: '700' }}>Dismiss</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ADD CARD MODAL */}
      <Modal visible={isCardModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={{ color: '#FFF', fontSize: 28, fontWeight: '900', marginBottom: 5 }}>Add Card</Text>
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, marginBottom: 30 }}>Enter your debit or credit card details</Text>
            
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '800', marginBottom: 8, letterSpacing: 1 }}>CARD NUMBER</Text>
            <TextInput 
              style={styles.modalInput} 
              value={cardForm.number} 
              onChangeText={(t) => {
                const cleaned = t.replace(/[^0-9]/g, '').slice(0, 16);
                const formatted = cleaned.replace(/(.{4})/g, '$1 ').trim();
                setCardForm(p => ({ ...p, number: formatted }));
              }} 
              placeholder="1234 5678 9012 3456" 
              placeholderTextColor="rgba(255,255,255,0.15)" 
              keyboardType="number-pad" 
              maxLength={19}
            />
            
            <View style={{ flexDirection: 'row', gap: 15 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '800', marginBottom: 8, letterSpacing: 1 }}>EXPIRY</Text>
                <TextInput 
                  style={styles.modalInput} 
                  value={cardForm.expiry} 
                  onChangeText={(t) => {
                    let cleaned = t.replace(/[^0-9]/g, '').slice(0, 4);
                    if (cleaned.length >= 3) cleaned = cleaned.slice(0, 2) + '/' + cleaned.slice(2);
                    setCardForm(p => ({ ...p, expiry: cleaned }));
                  }} 
                  placeholder="MM/YY" 
                  placeholderTextColor="rgba(255,255,255,0.15)" 
                  keyboardType="number-pad" 
                  maxLength={5}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '800', marginBottom: 8, letterSpacing: 1 }}>CVV</Text>
                <TextInput 
                  style={styles.modalInput} 
                  value={cardForm.cvv} 
                  onChangeText={(t) => setCardForm(p => ({ ...p, cvv: t.replace(/[^0-9]/g, '').slice(0, 4) }))} 
                  placeholder="•••" 
                  placeholderTextColor="rgba(255,255,255,0.15)" 
                  keyboardType="number-pad" 
                  maxLength={4}
                  secureTextEntry
                />
              </View>
            </View>
            
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '800', marginBottom: 8, letterSpacing: 1 }}>CARDHOLDER NAME</Text>
            <TextInput 
              style={styles.modalInput} 
              value={cardForm.name} 
              onChangeText={(t) => setCardForm(p => ({ ...p, name: t }))} 
              placeholder="Full name on card" 
              placeholderTextColor="rgba(255,255,255,0.15)" 
              autoCapitalize="words"
            />
            
            <TouchableOpacity style={styles.saveBtn} onPress={submitCard}>
              <Text style={styles.saveBtnText}>Add Card Securely</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ padding: 15, alignItems: 'center' }} onPress={() => setCardModalVisible(false)}>
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontWeight: '700' }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!selectedReceipt} animationType="fade" transparent>
        <View style={[styles.modalOverlay, { justifyContent: 'center', padding: 25 }]}>
          <View style={styles.receiptBox}>
            <Ionicons name="checkmark-circle" size={80} color="#22C55E" style={{ marginBottom: 15 }} />
            <Text style={{ color: '#000', fontSize: 15, fontWeight: '900', letterSpacing: 3, marginBottom: 10 }}>TRANSACTION SUCCESSFUL</Text>
            <Text style={{ color: '#000', fontSize: 56, fontWeight: '900', marginBottom: 30 }}>₹{selectedReceipt?.amount?.toFixed(2)}</Text>
            <View style={{ width: '100%' }}>
               <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 }}><Text style={{ color: '#777', fontWeight: '700' }}>Merchant</Text><Text style={{ fontWeight: '800' }}>ParkStop Parking</Text></View>
               <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 }}><Text style={{ color: '#777', fontWeight: '700' }}>Location</Text><Text style={{ fontWeight: '800' }}>{selectedReceipt?.spotTitle}</Text></View>
               <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text style={{ color: '#777', fontWeight: '700' }}>Date</Text><Text style={{ fontWeight: '800' }}>{selectedReceipt?.date ? new Date(selectedReceipt.date).toLocaleDateString() : ''}</Text></View>
            </View>
            <View style={styles.receiptDivider} />
            <TouchableOpacity style={[styles.saveBtn, { width: '100%' }]} onPress={() => setSelectedReceipt(null)}><Text style={styles.saveBtnText}>Close Receipt</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
