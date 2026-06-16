import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import apiClient from '../api/client';

// Configure how notifications appear when the app is in the foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Request permission and get the Expo Push Token for the current device.
 * It will then send the token to our backend to be saved to the database.
 */
export async function registerForPushNotificationsAsync() {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3b82f6',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    
    if (finalStatus !== 'granted') {
      console.log('Failed to get push token for push notification!');
      return null;
    }
    
    try {
      const projectId = process.env.EXPO_PUBLIC_PROJECT_ID;
      if (!projectId) {
        console.log('Notice: Push notifications are disabled in local Expo Go because EXPO_PUBLIC_PROJECT_ID is not configured in environment variables.');
        return null;
      }
      token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      console.log('Obtained Expo Push Token:', token);

      // Send the token to the backend
      await apiClient.post('/auth/push-token', { push_token: token });
      
    } catch (e) {
      console.log('Error getting or saving push token (EAS setup required):', e);
    }
  } else {
    console.log('Must use physical device for Push Notifications');
  }

  return token;
}
