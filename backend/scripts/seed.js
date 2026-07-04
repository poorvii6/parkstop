const db = require('../src/config/database');

async function seed() {
  console.log('🌱 Seeding database...');

  try {
    // 1. Create a default spotter (no password column, include name and full_name)
    const userRes = await db.query(
      `INSERT INTO users (email, name, full_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, name = EXCLUDED.name
       RETURNING id`,
      ['spotter@parkstop.com', 'Master Spotter', 'Master Spotter', 'spotter']
    );
    const spotterId = userRes.rows[0].id;

    // 2. Create some spots around SF and Bangalore (to cover the user's local tests)
    const spots = [
      { title: 'Union Square Garage', lat: 37.7880, lng: -122.4075, price: 12.50, type: 'Garage' },
      { title: 'Mission District Driveway', lat: 37.7599, lng: -122.4148, price: 8.00, type: 'Driveway' },
      { title: 'Fisherman\'s Wharf Lot', lat: 37.8080, lng: -122.4177, price: 15.00, type: 'Lot' },
      { title: 'SOMA Private Spot', lat: 37.7785, lng: -122.3967, price: 10.00, type: 'Private' },
      // Bangalore locations
      { title: 'MG Road EV Station', lat: 12.9740, lng: 77.6080, price: 50.00, type: 'EV Charge' },
      { title: 'Indiranagar Premium Parking', lat: 12.9780, lng: 77.6400, price: 40.00, type: 'Secure' },
      { title: 'Koramangala Block 5 Lot', lat: 12.9350, lng: 77.6240, price: 30.00, type: 'Lot' },
      { title: 'Whitefield Tech Park Garage', lat: 12.9840, lng: 77.7340, price: 60.00, type: 'Garage' },
      { title: 'Jayanagar Open Parking', lat: 12.9250, lng: 77.5930, price: 20.00, type: 'Open' },
      // Doddaballapur locations
      { title: 'Doddaballapur Central EV Station', lat: 13.2950, lng: 77.5380, price: 25.00, type: 'EV Charge' },
      { title: 'Doddaballapur Market Garage', lat: 13.2980, lng: 77.5400, price: 15.00, type: 'Garage' },
      // Chikkaballapur locations
      { title: 'Chikkaballapur Highway EV Charge', lat: 13.4350, lng: 77.7280, price: 30.00, type: 'EV Charge' },
      { title: 'Nandi Hills Base Parking', lat: 13.3760, lng: 77.6830, price: 50.00, type: 'Secure' },
      // Hoskote locations
      { title: 'Hoskote Toll EV Station', lat: 13.0720, lng: 77.7980, price: 35.00, type: 'EV Charge' },
      { title: 'Hoskote Industrial Area Parking', lat: 13.0680, lng: 77.8000, price: 20.00, type: 'Open' },
    ];

    for (const spot of spots) {
      await db.query(
        `INSERT INTO parking_spots (spotter_id, title, address, latitude, longitude, price_per_hour, available_slots, total_slots, location_type, is_available, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true)`,
        [spotterId, spot.title, spot.title + " Address", spot.lat, spot.lng, spot.price, 10, 10, 'urban']
      );
    }

    console.log(`✅ Seeding complete! Added ${spots.length} spots.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  }
}

seed();
