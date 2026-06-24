-- Update all location types to lowercase
UPDATE "parking_spots" SET location_type = LOWER(location_type) WHERE location_type != LOWER(location_type);

-- Add check constraint to prevent case issues in future
ALTER TABLE "parking_spots" 
  ADD CONSTRAINT location_type_check CHECK (location_type = LOWER(location_type));
