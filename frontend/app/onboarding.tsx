import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Easing, useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

const ACCENT = BlueprintColors.primaryAccent;
const MUTED = BlueprintColors.textSecondary;
const GREEN = '#10B981';
const BLUE = '#3B82F6';
const SKIN = '#F3C89B';

/* ---------- reusable pieces ---------- */
function Person({ shirt = ACCENT, hair = '#2A2A38' }: { shirt?: string; hair?: string }) {
  return (
    <View style={{ width: 64, height: 106 }}>
      <View style={{ position: 'absolute', top: 0, left: 9, width: 46, height: 30, borderTopLeftRadius: 23, borderTopRightRadius: 23, backgroundColor: hair }} />
      <View style={{ position: 'absolute', top: 8, left: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: SKIN }} />
      <View style={{ position: 'absolute', top: 46, left: 3, width: 58, height: 60, borderTopLeftRadius: 29, borderTopRightRadius: 29, borderBottomLeftRadius: 16, borderBottomRightRadius: 16, backgroundColor: shirt }} />
    </View>
  );
}

function MiniPhone() {
  return (
    <View style={{ width: 30, height: 54, borderRadius: 8, backgroundColor: '#0C0C14', borderWidth: 2, borderColor: '#3A4056', padding: 3 }}>
      <View style={{ flex: 1, borderRadius: 4, backgroundColor: '#12324a', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ACCENT }} />
      </View>
    </View>
  );
}

function Car({ color = ACCENT }: { color?: string }) {
  return (
    <View style={{ width: 108, height: 50 }}>
      <View style={{ position: 'absolute', top: 2, left: 26, width: 58, height: 24, borderTopLeftRadius: 16, borderTopRightRadius: 16, backgroundColor: color }} />
      <View style={{ position: 'absolute', top: 8, left: 33, width: 44, height: 14, borderRadius: 6, backgroundColor: '#CBE1FF' }} />
      <View style={{ position: 'absolute', top: 22, left: 0, width: 108, height: 22, borderRadius: 13, backgroundColor: color }} />
      <View style={{ position: 'absolute', bottom: 0, left: 16, width: 18, height: 18, borderRadius: 9, backgroundColor: '#15151c', borderWidth: 4, borderColor: '#3a3a48' }} />
      <View style={{ position: 'absolute', bottom: 0, right: 16, width: 18, height: 18, borderRadius: 9, backgroundColor: '#15151c', borderWidth: 4, borderColor: '#3a3a48' }} />
    </View>
  );
}

function Pin() {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(y, { toValue: -12, duration: 750, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: 750, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{ alignItems: 'center', transform: [{ translateY: y }] }}>
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#FFFFFF' }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#FFFFFF' }} />
      </View>
      <View style={{ width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderTopWidth: 15, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: ACCENT, marginTop: -3 }} />
    </Animated.View>
  );
}

function Coin({ left, delay }: { left: number; delay: number }) {
  const y = useRef(new Animated.Value(0)).current;
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.parallel([
        Animated.timing(y, { toValue: -52, duration: 1700, delay, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(o, { toValue: 1, duration: 350, delay, useNativeDriver: true }),
          Animated.timing(o, { toValue: 0, duration: 1000, useNativeDriver: true }),
        ]),
      ]),
      Animated.timing(y, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View style={{ position: 'absolute', left, bottom: 44, opacity: o, transform: [{ translateY: y }] }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFD34D', borderWidth: 2, borderColor: '#E4A81C', alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#7A4E00', fontWeight: '900', fontSize: 13 }}>₹</Text>
      </View>
    </Animated.View>
  );
}

/* ---------- scenes ---------- */
function SceneFind() {
  return (
    <View style={sc.canvas}>
      <View style={sc.ground} />
      <View style={{ position: 'absolute', left: 34, bottom: 34, flexDirection: 'row', alignItems: 'flex-end' }}>
        <Person shirt={ACCENT} />
        <View style={{ marginLeft: -12, marginBottom: 24 }}><MiniPhone /></View>
      </View>
      <View style={{ position: 'absolute', right: 46, top: 14 }}><Pin /></View>
      <View style={[sc.dotPath, { right: 120, top: 92 }]} />
      <View style={[sc.dotPath, { right: 104, top: 104 }]} />
      <View style={[sc.dotPath, { right: 86, top: 112 }]} />
    </View>
  );
}

function SceneBook() {
  const x = useRef(new Animated.Value(-150)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(x, { toValue: 0, duration: 1500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(1100),
      Animated.timing(x, { toValue: -150, duration: 0, useNativeDriver: true }),
      Animated.delay(250),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <View style={sc.canvas}>
      <View style={sc.ground} />
      <View style={sc.spot}><Text style={sc.spotP}>P</Text></View>
      <Animated.View style={{ position: 'absolute', bottom: 34, left: 76, transform: [{ translateX: x }] }}>
        <Car color={ACCENT} />
      </Animated.View>
      <View style={sc.badge}><Text style={sc.badgeTxt}>✓  Booked</Text></View>
    </View>
  );
}

function SceneEarn() {
  return (
    <View style={sc.canvas}>
      <View style={sc.ground} />
      <View style={{ position: 'absolute', left: 40, bottom: 34 }}><Person shirt={GREEN} /></View>
      <View style={{ position: 'absolute', right: 60, bottom: 34, alignItems: 'center' }}>
        <View style={sc.sign}><Text style={sc.spotP}>P</Text></View>
        <View style={sc.signPost} />
      </View>
      <Coin left={150} delay={0} />
      <Coin left={176} delay={550} />
      <Coin left={132} delay={1000} />
    </View>
  );
}

const SLIDES = [
  { Scene: SceneFind, title: 'Find a spot near you', desc: 'Open the map and see available parking around you.' },
  { Scene: SceneBook, title: 'Book it & pull in', desc: 'Reserve in a tap, pay securely, and park with ease.' },
  { Scene: SceneEarn, title: 'Earn from your space', desc: 'List a spot you own and get paid when it’s booked.' },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const [index, setIndex] = useState(0);

  const finish = async (dest: string) => {
    try { await AsyncStorage.setItem('has_seen_onboarding', 'true'); } catch {}
    router.replace(dest);
  };

  const isLast = index === SLIDES.length - 1;
  const next = () => {
    if (isLast) return finish('/register');
    const to = index + 1;
    scrollRef.current?.scrollTo({ x: width * to, animated: true });
    setIndex(to);
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => finish('/welcome')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.skip}>Skip</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false })}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
      >
        {SLIDES.map((slide, i) => {
          const inputRange = [(i - 1) * width, i * width, (i + 1) * width];
          const scale = scrollX.interpolate({ inputRange, outputRange: [0.82, 1, 0.82], extrapolate: 'clamp' });
          const opacity = scrollX.interpolate({ inputRange, outputRange: [0.2, 1, 0.2], extrapolate: 'clamp' });
          const lift = scrollX.interpolate({ inputRange, outputRange: [24, 0, 24], extrapolate: 'clamp' });
          const Scene = slide.Scene;
          return (
            <View key={i} style={[s.slide, { width }]}>
              <Animated.View style={{ opacity, transform: [{ scale }] }}>
                <Scene />
              </Animated.View>
              <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
                <Text style={s.title}>{slide.title}</Text>
                <Text style={s.desc}>{slide.desc}</Text>
              </Animated.View>
            </View>
          );
        })}
      </ScrollView>

      <View style={s.dots}>
        {SLIDES.map((_, i) => {
          const inputRange = [(i - 1) * width, i * width, (i + 1) * width];
          const dotW = scrollX.interpolate({ inputRange, outputRange: [8, 26, 8], extrapolate: 'clamp' });
          const dotO = scrollX.interpolate({ inputRange, outputRange: [0.3, 1, 0.3], extrapolate: 'clamp' });
          return <Animated.View key={i} style={[s.dot, { width: dotW, opacity: dotO }]} />;
        })}
      </View>

      <View style={s.footer}>
        <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={next} activeOpacity={0.9}>
          <Text style={BlueprintTheme.buttonPrimaryText}>{isLast ? 'Get Started' : 'Next'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  topBar: { alignItems: 'flex-end', paddingHorizontal: 24, paddingTop: 8, height: 44, justifyContent: 'center' },
  skip: { color: MUTED, fontSize: 15, fontWeight: '600' },
  slide: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  title: { fontSize: 26, fontWeight: '800', color: '#FFFFFF', textAlign: 'center', marginTop: 44, marginBottom: 12 },
  desc: { fontSize: 16, color: MUTED, textAlign: 'center', lineHeight: 24, paddingHorizontal: 8 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, height: 10, marginVertical: 24 },
  dot: { height: 8, borderRadius: 4, backgroundColor: ACCENT },
  footer: { paddingHorizontal: 24, paddingBottom: 16 },
});

const sc = StyleSheet.create({
  canvas: { width: 270, height: 190, alignSelf: 'center' },
  ground: {
    position: 'absolute', bottom: 24, alignSelf: 'center', left: 25, width: 220, height: 22,
    borderRadius: 100, backgroundColor: 'rgba(255,255,255,0.05)',
  },
  dotPath: { position: 'absolute', width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,107,44,0.6)' },
  spot: {
    position: 'absolute', bottom: 30, alignSelf: 'center', left: 95, width: 80, height: 40,
    borderRadius: 8, borderWidth: 2, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  spotP: { color: ACCENT, fontSize: 22, fontWeight: '900' },
  badge: {
    position: 'absolute', top: 18, right: 34, backgroundColor: 'rgba(16,185,129,0.16)',
    borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: GREEN,
  },
  badgeTxt: { color: GREEN, fontSize: 12, fontWeight: '800' },
  sign: {
    width: 46, height: 46, borderRadius: 10, backgroundColor: 'rgba(255,107,44,0.16)',
    borderWidth: 2, borderColor: ACCENT, alignItems: 'center', justifyContent: 'center',
  },
  signPost: { width: 6, height: 34, backgroundColor: 'rgba(255,255,255,0.18)' },
});
