/**
 * useSpotterDashboard — owns all data loading for the Spotter dashboard.
 *
 * Extracted from app/spotter/index.tsx so the screen is presentation only, and
 * so this logic can be reused (and eventually tested) independently.
 *
 * Responsibilities:
 *   - fetch /spots/dashboard on focus, on pull-to-refresh, and on realtime events
 *   - fetch payout account status
 *   - track load FAILURE distinctly from empty data, so a network drop is never
 *     rendered as "you earned ₹0"
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import apiClient from '../api/client';
import { onRealtime } from '../services/realtime';
import { registerForPushNotificationsAsync } from '../services/notifications';

export type SpotterDashboardData = {
  active_spots: number;
  earnings: number;
  revenue_trend: number[];
  surge_factor: number;
  inventory: any[];
  recent_traffic: any[];
  balance: number;
  occupancy_rate: number;
  avg_duration: number;
  global_online: boolean;
  payout_history: any[];
};

export const EMPTY_DASHBOARD: SpotterDashboardData = {
  active_spots: 0,
  earnings: 0,
  revenue_trend: [0, 0, 0, 0, 0, 0, 0],
  surge_factor: 1,
  inventory: [],
  recent_traffic: [],
  balance: 0,
  occupancy_rate: 0,
  avg_duration: 0.0,
  global_online: false,
  payout_history: [],
};

export function useSpotterDashboard() {
  const [data, setData] = useState<SpotterDashboardData>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [payoutSetup, setPayoutSetup] = useState<boolean | null>(null);

  // Guards against setState after unmount (realtime events can land late).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fetchDashboardData = useCallback(async () => {
    try {
      const res = await apiClient.get('/spots/dashboard');
      if (!mounted.current) return;
      if (res.data?.success) {
        setData(res.data.data);
        setLoadFailed(false);
        setLastSyncedAt(new Date());
      } else {
        setLoadFailed(true);
      }
    } catch (e) {
      // Never let a network failure look like real money data: previously this
      // was swallowed, so a dropped connection rendered ₹0 earnings / 0 spots,
      // indistinguishable from genuinely having earned nothing.
      console.log('Error fetching dashboard', e);
      if (mounted.current) setLoadFailed(true);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // Live updates: a new/cancelled booking refreshes instantly — a host must
  // never miss a booking waiting for a manual pull-to-refresh.
  useEffect(() => {
    const offNew = onRealtime('booking:new', () => fetchDashboardData());
    const offCancelled = onRealtime('booking:cancelled', () => fetchDashboardData());
    const offPayout = onRealtime('payout:pending', () => fetchDashboardData());
    return () => { offNew(); offCancelled(); offPayout(); };
  }, [fetchDashboardData]);

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
      // Push registration is idempotent and must stay tied to the dashboard
      // becoming visible — without it a spotter silently stops getting booking
      // notifications.
      registerForPushNotificationsAsync();
      apiClient
        .get('/payouts/account-status')
        .then((res) => {
          if (mounted.current && res.data?.success) setPayoutSetup(res.data.data.is_setup);
        })
        .catch(() => { if (mounted.current) setPayoutSetup(false); });
    }, [fetchDashboardData])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  return {
    data,
    setData,
    loading,
    refreshing,
    loadFailed,
    lastSyncedAt,
    payoutSetup,
    refetch: fetchDashboardData,
    onRefresh,
  };
}
