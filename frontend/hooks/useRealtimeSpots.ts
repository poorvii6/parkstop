import { useState, useEffect } from 'react';
import io, { Socket } from 'socket.io-client';
import apiClient from '../api/client';

const SOCKET_URL = process.env.EXPO_PUBLIC_API_URL?.replace('/api/v1', '') || 'http://192.168.1.100:3000';

export interface Spot {
  id: string;
  title: string;
  lat: number;
  lng: number;
  price: number;
  available: boolean;
  location_type?: string;
}

export function useRealtimeSpots(userLocation: { lat: number, lng: number } | null) {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Initial fetch when location becomes available
  useEffect(() => {
    if (!userLocation) return;
    
    let isMounted = true;
    (async () => {
      try {
        const res = await apiClient.get(`/spots/nearby?lat=${userLocation.lat}&lng=${userLocation.lng}&radius=50`);
        if (res.data.success && isMounted) {
          setSpots(res.data.data.map((sp: any) => ({
            id: sp.id.toString(),
            title: sp.title,
            lat: parseFloat(sp.latitude),
            lng: parseFloat(sp.longitude),
            price: parseFloat(sp.price_per_hour),
            available: sp.available_slots > 0,
            location_type: sp.location_type
          })));
        }
      } catch (e) {
        console.log('Error fetching initial spots, using demo data', e);
        if (isMounted) {
          setSpots([
            { id: 'm1', title: 'Demo Spot A', lat: userLocation.lat + 0.005, lng: userLocation.lng + 0.005, price: 15, available: true },
            { id: 'm2', title: 'Demo Spot B', lat: userLocation.lat - 0.005, lng: userLocation.lng - 0.005, price: 12, available: true }
          ]);
        }
      }
    })();

    return () => { isMounted = false; };
  }, [userLocation?.lat, userLocation?.lng]); // only re-run if significantly changed

  // Socket.io connection
  useEffect(() => {
    const newSocket = io(SOCKET_URL, { transports: ['websocket'] });
    setSocket(newSocket);
    
    newSocket.on('spot_update', (updatedSpot: Spot) => {
      setSpots(current => current.map(s => s.id === updatedSpot.id ? updatedSpot : s));
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  return { spots, setSpots, socket };
}
