import React from 'react';
import { View, Text, StyleSheet, Modal, ScrollView, TextInput, TouchableOpacity, Dimensions, KeyboardAvoidingView, Platform } from 'react-native';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';

interface AIAssistantModalProps {
  visible: boolean;
  onClose: () => void;
  messages: { text: string, sender: 'bot' | 'user' }[];
  chatInput: string;
  setChatInput: (text: string) => void;
  onSend: () => void;
}

export const AIAssistantModal: React.FC<AIAssistantModalProps> = ({
  visible,
  onClose,
  messages,
  chatInput,
  setChatInput,
  onSend,
}) => {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.chatModalBg}
      >
        <View style={[styles.chatModal, BlueprintTheme.glassCard]}>
          <View style={styles.chatHeader}>
            <Text style={styles.chatTitle}>ParkStop AI</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.chatClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.chatBody}>
            {messages.map((m, i) => (
              <View key={i} style={[styles.chatBubble, m.sender === 'user' ? styles.chatUser : styles.chatBot]}>
                <Text style={styles.chatText}>{m.text}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.chatInputRow}>
            <TextInput 
              style={styles.chatInput} 
              placeholder="Ask something..." 
              placeholderTextColor={BlueprintColors.textSecondary} 
              value={chatInput} 
              onChangeText={setChatInput} 
              onSubmitEditing={onSend} 
            />
            <TouchableOpacity style={styles.sendBtn} onPress={onSend}>
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  chatModalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end', padding: 20 },
  chatModal: { height: Dimensions.get('window').height * 0.7, padding: 24, borderRadius: 32 },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center' },
  chatTitle: { fontSize: 20, fontWeight: '900', color: '#FFFFFF' },
  chatClose: { color: BlueprintColors.textSecondary, fontWeight: '700' },
  chatBody: { flex: 1 },
  chatBubble: { padding: 14, borderRadius: 20, marginBottom: 12, maxWidth: '85%' },
  chatBot: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.05)', borderBottomLeftRadius: 4 },
  chatUser: { alignSelf: 'flex-end', backgroundColor: BlueprintColors.primaryAccent, borderBottomRightRadius: 4 },
  chatText: { fontSize: 15, lineHeight: 22, color: '#FFFFFF' },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  chatInput: { 
    flex: 1, 
    backgroundColor: 'rgba(255,255,255,0.05)', 
    padding: 16, 
    borderRadius: 16, 
    color: '#FFFFFF', 
    fontSize: 15 
  },
  sendBtn: { padding: 10 },
  sendBtnText: { color: BlueprintColors.primaryAccent, fontWeight: '700' },
});
