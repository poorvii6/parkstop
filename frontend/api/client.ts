import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

let cachedApiUrl: string | null = null;

const getAPIUrl = async () => {
    // 1. Return cached version if available for speed
    if (cachedApiUrl) return cachedApiUrl;

    // 2. Check AsyncStorage for previously discovered IP
    try {
        const storedIp = await AsyncStorage.getItem('discovered_api_url');
        if (storedIp) {
            cachedApiUrl = storedIp;
            return storedIp;
        }
    } catch (e) {}

    let detectedUrl = '';

    // 3. Explicit environment variable
    if (process.env.EXPO_PUBLIC_API_URL) {
        detectedUrl = `${process.env.EXPO_PUBLIC_API_URL}/api/v1`;
    } 
    // 4. Web
    else if (Platform.OS === 'web') {
        detectedUrl = 'https://parkstop-production.up.railway.app/api/v1';
    } 
    // 5. Android Emulator
    else if (Platform.OS === 'android' && !Device.isDevice) {
        detectedUrl = 'http://10.0.2.2:3000/api/v1'; 
    } 
    // 6. Dynamic IP detection for Expo Go
    else {
        const debuggerHost = Constants.expoConfig?.hostUri || Constants.manifest2?.extra?.expoGoConfig?.debuggerHost;
        if (debuggerHost) {
            const ipAddress = debuggerHost.split(':')[0];
            detectedUrl = `http://${ipAddress}:3000/api/v1`;
        } else {
            // 7. Hardcoded Fallback
            detectedUrl = 'http://192.168.31.68:3000/api/v1'; 
        }
    }

    cachedApiUrl = detectedUrl;
    AsyncStorage.setItem('discovered_api_url', detectedUrl).catch(() => {});
    console.log(`[API] Optimized Discovery: ${detectedUrl}`);
    return detectedUrl;
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
    // Ensure baseURL is set (Lazy initialization)
    if (!config.baseURL) {
        config.baseURL = await getAPIUrl();
    }

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
