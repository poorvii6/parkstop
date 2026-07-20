/**
 * RevenueChart — 7-day earnings sparkline for the Spotter dashboard.
 *
 * Extracted from app/spotter/index.tsx.
 *
 * IMPORTANT — axis labelling. The backend builds `revenue_trend` as a ROLLING
 * window (see ParkingSpot.getSpotterDashboard): index 6 is TODAY and index 0 is
 * six days ago. The original version of this chart hardcoded ['Mon'...'Sun'],
 * which is only correct when today happens to be Sunday — on every other day
 * of the week each bar was attributed to the wrong day. Labels are now derived
 * from real dates so they always line up with the data.
 */

import React, { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, Dimensions } from 'react-native';
import { SC } from '../../constants/SpotterTheme';

const { width } = Dimensions.get('window');

const CHART_H = 120;
const PADDING_X = 36;

/** Labels for a rolling window ending today: [6 days ago … today]. */
function rollingDayLabels(count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(i === 0 ? 'Today' : d.toLocaleDateString('en-IN', { weekday: 'short' }));
  }
  return out;
}

type Props = { data?: number[] };

export default function RevenueChart({ data = [0, 0, 0, 0, 0, 0, 0] }: Props) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const maxVal = Math.max(...data, 1);
  const chartW = width - 80;
  const stepX = (chartW - PADDING_X) / (data.length - 1 || 1);

  // Recomputed only when the series changes, not on every tooltip tap.
  const points = useMemo(
    () =>
      data.map((val, i) => ({
        x: PADDING_X + i * stepX,
        y: CHART_H - (val / maxVal) * CHART_H,
      })),
    [data, stepX, maxVal]
  );

  const days = useMemo(() => rollingDayLabels(data.length), [data.length]);

  const lines = useMemo(() => {
    const segs = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      segs.push(
        <View
          key={`l-${i}`}
          style={{
            position: 'absolute',
            left: p1.x,
            top: p1.y,
            width: length,
            height: 3,
            backgroundColor: SC.accent,
            borderRadius: 2,
            transform: [
              { translateY: -1.5 },
              { rotate: `${angle}deg` },
              { translateX: length / 2 - dx / 2 },
              { translateY: dy / 2 },
            ],
          }}
        />
      );
    }
    return segs;
  }, [points]);

  const yLabels = [maxVal, maxVal * 0.5, 0].map((v) =>
    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toString()
  );

  const total = data.reduce((a, b) => a + b, 0);

  return (
    <View
      style={{ height: CHART_H + 54, position: 'relative' }}
      accessibilityLabel={`Earnings for the last ${data.length} days, totalling ${total.toFixed(2)} rupees`}
    >
      {/* Tooltip banner */}
      <View style={{ height: 26, justifyContent: 'center', alignItems: 'center', marginBottom: 6 }}>
        {activeIdx !== null ? (
          <Text style={{ color: SC.accent, fontSize: 13, fontWeight: '900', letterSpacing: 0.5 }}>
            {days[activeIdx]}: ₹{data[activeIdx].toFixed(2)}
          </Text>
        ) : (
          <Text style={{ color: SC.textMuted, fontSize: 11, fontWeight: '600' }}>
            Tap dots to view daily earnings
          </Text>
        )}
      </View>

      {/* Y axis */}
      <View style={{ position: 'absolute', left: 0, top: 32, bottom: 20, justifyContent: 'space-between' }}>
        {yLabels.map((l, i) => (
          <Text key={i} style={{ color: SC.textMuted, fontSize: 9, width: 30, textAlign: 'right' }}>
            {l}
          </Text>
        ))}
      </View>

      {/* Gridlines */}
      <View style={{ position: 'absolute', left: PADDING_X, right: 0, top: 32, bottom: 20, justifyContent: 'space-between' }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', width: '100%' }} />
        ))}
      </View>

      {/* Series */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: 32, bottom: 20 }}>
        {lines}
        {points.map((p, i) => {
          const isActive = activeIdx === i;
          return (
            <TouchableOpacity
              key={`d-${i}`}
              activeOpacity={0.7}
              onPress={() => setActiveIdx(activeIdx === i ? null : i)}
              accessibilityRole="button"
              accessibilityLabel={`${days[i]}: ${data[i].toFixed(2)} rupees`}
              style={{
                position: 'absolute',
                left: p.x - 14,
                top: p.y - 14,
                width: 28,
                height: 28,
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 20,
              }}
            >
              <View
                style={{
                  width: isActive ? 12 : 8,
                  height: isActive ? 12 : 8,
                  borderRadius: isActive ? 6 : 4,
                  backgroundColor: isActive ? '#FFF' : SC.accent,
                  borderWidth: 2,
                  borderColor: isActive ? SC.accent : SC.bgCard,
                  shadowColor: SC.accent,
                  shadowOpacity: isActive ? 0.8 : 0,
                  shadowRadius: 4,
                  elevation: isActive ? 4 : 0,
                }}
              />
            </TouchableOpacity>
          );
        })}
      </View>

      {/* X axis */}
      <View style={{ position: 'absolute', left: PADDING_X, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
        {days.map((d, i) => (
          <Text
            key={i}
            style={{
              color: activeIdx === i ? SC.accent : SC.textMuted,
              fontSize: 9,
              fontWeight: activeIdx === i ? '900' : '500',
            }}
          >
            {d}
          </Text>
        ))}
      </View>
    </View>
  );
}
