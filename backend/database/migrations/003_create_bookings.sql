-- Create bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  finder_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id INTEGER NOT NULL REFERENCES parking_spots(id) ON DELETE CASCADE,
  otp VARCHAR(10) NOT NULL,
  otp_expires_at TIMESTAMP NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  finder_lat DECIMAL(10, 8),
  finder_lng DECIMAL(11, 8),
  estimated_arrival TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX idx_bookings_finder ON bookings(finder_id);
CREATE INDEX idx_bookings_spot ON bookings(spot_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_created ON bookings(created_at);
CREATE INDEX idx_bookings_otp ON bookings(otp);