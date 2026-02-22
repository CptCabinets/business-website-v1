const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'bookings.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Initialize schema
function initDatabase() {
  // Cleaners table
  db.exec(`
    CREATE TABLE IF NOT EXISTS cleaners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT,
      email TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Bookings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      booking_date DATE NOT NULL,
      start_time TEXT,
      duration_hours REAL NOT NULL,
      num_cleaners INTEGER DEFAULT 1,
      price REAL,
      notes TEXT,
      status TEXT DEFAULT 'confirmed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Booking-Cleaner assignments (many-to-many)
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_cleaners (
      booking_id INTEGER,
      cleaner_id INTEGER,
      PRIMARY KEY (booking_id, cleaner_id),
      FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
      FOREIGN KEY (cleaner_id) REFERENCES cleaners(id) ON DELETE CASCADE
    );
  `);

  // Insert default cleaners if none exist
  const count = db.prepare('SELECT COUNT(*) as count FROM cleaners').get();
  if (count.count === 0) {
    const insertCleaner = db.prepare('INSERT INTO cleaners (name) VALUES (?)');
    insertCleaner.run('Aisling');
    insertCleaner.run('Jena');
    insertCleaner.run('Caroline');
    console.log('✓ Default cleaners added: Aisling, Jena, Caroline');
  }
}

initDatabase();

module.exports = db;
