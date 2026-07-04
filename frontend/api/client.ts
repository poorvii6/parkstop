import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { auth } from '../services/firebase';

let cachedApiUrl: string | null = null;

const getAPIUrlSync = () => {
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

const getAPIUrl = async () => {
  return getAPIUrlSync();
};

const apiClient = axios.create({
  baseURL: getAPIUrlSync(),
  timeout: 15000,
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
      const currentUser = auth.currentUser;
      if (currentUser) {
        const token = await currentUser.getIdToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      } else {
        // Fallback for guest mode / offline_token
        const token = await AsyncStorage.getItem('access_token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      }
    } catch (e) {
      console.error('Auth Request Interceptor Error:', e);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// RESPONSE INTERCEPTOR: Handle 401 Unauthorized globally
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response && error.response.status === 401) {
      console.log('[API] Request returned 401 Unauthorized - Redirecting to login.');
      
      // Clear local session storage
      await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role']);
      
      try {
        await auth.signOut();
      } catch (signOutErr) {
        console.error('Signout Error on 401:', signOutErr);
      }

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
