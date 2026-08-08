import React, { useState, useCallback, useEffect } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../api/client';
import { addNotificationListeners } from '../services/notifications';
import { useOnlineRefresh } from '../hooks/useOnlineRefresh';

/**
 * Bell icon with an unread badge that opens the notifications screen. Drop it
 * into any header. Keeps the unread count fresh on focus, on a new push, and on
 * reconnect.
 */
export default function NotificationBell({ color = '#FFFFFF', size = 22 }: { color?: string; size?: number }) {
  const router = useRouter();
  const [unread, setUnread] = useState(0);

  const fetchUnread = useCallback(async () => {
    try {
      const res = await apiClient.get('/notifications');
      if (res.data?.success) setUnread(res.data.data.unread || 0);
    } catch {
      // stay quiet — a failed count must never disrupt the screen
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchUnread(); }, [fetchUnread]));
  useOnlineRefresh(fetchUnread);
  useEffect(() => {
    const off = addNotificationListeners({ onReceived: () => fetchUnread() });
    return off;
  }, [fetchUnread]);

  return (
    <TouchableOpacity onPress={() => router.push('/notifications')} hitSlop={10} style={styles.wrap} activeOpacity={0.7}>
      <Ionicons name="notifications-outline" size={size} color={color} />
      {unread > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 4 },
  badge: {
    position: 'absolute',
    top: -1,
    right: -1,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FF5733',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: '#0C0C14',
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});
