import React from 'react';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

export default function UniversalMap({ style, initialRegion, children, ...props }: any) {
  return (
    <MapView 
      style={style} 
      provider={PROVIDER_GOOGLE}
      initialRegion={initialRegion}
      {...props}
    >
      {children}
    </MapView>
  );
}

export { Marker };
