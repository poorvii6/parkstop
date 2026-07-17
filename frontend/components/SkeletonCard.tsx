import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

// A shimmering placeholder card shown while content loads.
// Extracted from app/finder/index.tsx — self-contained, no external state.
export default function SkeletonCard({
  width,
  height,
  style,
}: {
  width?: any;
  height?: any;
  style?: any;
}) {
  const fadeAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0.8,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0.4,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [fadeAnim]);

  return (
    <Animated.View
      style={[
        {
          width: width || '100%',
          height: height || 80,
          backgroundColor: 'rgba(255, 255, 255, 0.08)',
          borderRadius: 16,
          opacity: fadeAnim,
        },
        style,
      ]}
    />
  );
}
