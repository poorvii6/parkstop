/**
 * MapLibreView — now a thin alias for the Google Navigation SDK browsing map.
 *
 * HISTORY, BRIEFLY
 * ----------------
 * This file used to be the map: first a WebView running maplibre-gl, then
 * @maplibre/maplibre-react-native. Both were replaced by GoogleBrowseMap, which
 * renders the Navigation SDK's MapView so that browsing and guidance share one
 * basemap instead of switching appearance mid-journey.
 *
 * After the migration this file kept ~600 lines of that old implementation
 * below an unconditional `return`, deliberately, so a bad Navigation SDK
 * experience could be reverted by changing a single line. The SDK has since
 * been exercised on real rides — routing, arrival, check-in — so the insurance
 * has been paid out and the dead code is gone. It remains in git history if it
 * is ever genuinely needed.
 *
 * The name is kept because dozens of call sites import it. Every prop is passed
 * straight through, so this is a rename, not a wrapper with behaviour.
 */
import React from 'react';
import GoogleBrowseMap from './GoogleBrowseMap';

const MapLibreView = React.forwardRef((props: any, ref: any) => (
  <GoogleBrowseMap {...props} ref={ref} />
));

MapLibreView.displayName = 'MapLibreView';

export default MapLibreView;
