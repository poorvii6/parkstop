-- Create parking_spots table
CREATE TABLE IF NOT EXISTS parking_spots (
  id SERIAL PRIMARY KEY,
  spotter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  base_price DECIMAL(10, 2) NOT NULL,
  total_slots INTEGER NOT NULL,
  available_slots INTEGER NOT NULL,
  location_type VARCHAR(20) NOT NULL CHECK (location_type IN ('urban', 'suburban', 'rural')),
  amenities TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_parking_spots_spotter ON parking_spots(spotter_id);
CREATE INDEX idx_parking_spots_location ON parking_spots(latitude, longitude);
CREATE INDEX idx_parking_spots_active ON parking_spots(is_active);
CREATE INDEX idx_parking_spots_available ON parking_spots(available_slots);