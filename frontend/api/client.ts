import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

let cachedApiUrl: string | null = null;

const getAPIUrl = async () => {
  if (cachedApiUrl) return cachedApiUrl;

  let apiUrl =
    process.env.EXPO_PUBLIC_API_URL ||
    'https://parkstop-production.up.railway.app/api/v1';

  // In local development, dynamically rewrite localhost to the Metro host IP 
  // so physical devices and emulators can reach the backend server
  if (__DEV__ && Platform.OS !== 'web') {
    const hostUri = Constants.expoConfig?.hostUri || '';
    const metroHost = hostUri.split(':')[0];
    if (metroHost) {
      if (apiUrl.includes('localhost')) {
        apiUrl = apiUrl.replace('localhost', metroHost);
        console.log(`[API] Rewrote localhost to Metro host: ${metroHost}`);
      } else if (apiUrl.includes('127.0.0.1')) {
        apiUrl = apiUrl.replace('127.0.0.1', metroHost);
        console.log(`[API] Rewrote 127.0.0.1 to Metro host: ${metroHost}`);
      }
    }
  }

  cachedApiUrl = apiUrl;

  console.log(`[API] Using backend: ${apiUrl}`);
  return apiUrl;
};

const apiClient = axios.create({
  timeout: 15000, // Reduced timeout for faster failure/retry
  headers: {
    'Bypass-Tunnel-Reminder': 'true',
  },
});

// REQUEST INTERCEPTOR: Inject dynamic URL and Auth token
apiClient.interceptors.request.use(
  async (config) => {
    if (!config.baseURL) {
      config.baseURL = await getAPIUrl();
    }

    console.log('[API REQUEST]');
    console.log('Base URL:', config.baseURL);
    console.log('Final URL:', `${config.baseURL}${config.url}`);

    try {
      const token = await AsyncStorage.getItem('access_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (e) {
      console.error('AsyncStorage Error:', e);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response && error.response.status === 401) {
      if (error.config.url?.includes('/auth/login')) {
        return Promise.reject(error);
      }

      const token = await AsyncStorage.getItem('access_token');
      if (token === 'offline_token') return Promise.reject(error);
      
      console.log('401 Unauthorized - Clearing session');
      await AsyncStorage.multiRemove(['access_token', 'user_role']);
      
      if (Platform.OS !== 'web') {
        const { Alert } = require('react-native');
        Alert.alert('Session Expired', 'Please log in again.', [{ text: 'OK' }]);
      }
      
      const { router } = require('expo-router');
      router.replace('/login');
    }
    return Promise.reject(error);
  }
);

export default apiClient;
