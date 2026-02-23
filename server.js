const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static('.'));  // Also serve root (index.html, css/, assets/)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// === CLEANERS API ===

// Get all cleaners
app.get('/api/cleaners', (req, res) => {
  try {
    const cleaners = db.prepare('SELECT * FROM cleaners ORDER BY name').all();
    res.json(cleaners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === BOOKINGS API ===

// Get bookings with optional date range
app.get('/api/bookings', (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let query = `
      SELECT 
        b.*,
        GROUP_CONCAT(c.name, ', ') as assigned_cleaners
      FROM bookings b
      LEFT JOIN booking_cleaners bc ON b.id = bc.booking_id
      LEFT JOIN cleaners c ON bc.cleaner_id = c.id
    `;
    const params = [];
    
    if (start_date && end_date) {
      query += ' WHERE b.booking_date BETWEEN ? AND ?';
      params.push(start_date, end_date);
    } else if (start_date) {
      query += ' WHERE b.booking_date >= ?';
      params.push(start_date);
    } else if (end_date) {
      query += ' WHERE b.booking_date <= ?';
      params.push(end_date);
    }
    
    query += ' GROUP BY b.id ORDER BY b.booking_date, b.start_time';
    
    const bookings = db.prepare(query).all(...params);
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single booking
app.get('/api/bookings/:id', (req, res) => {
  try {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    // Get assigned cleaners
    const cleaners = db.prepare(`
      SELECT c.id, c.name 
      FROM booking_cleaners bc 
      JOIN cleaners c ON bc.cleaner_id = c.id 
      WHERE bc.booking_id = ?
    `).all(req.params.id);
    
    booking.cleaners = cleaners;
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new booking
app.post('/api/bookings', (req, res) => {
  try {
    const {
      customer_name,
      address,
      phone,
      email,
      booking_date,
      start_time,
      duration_hours,
      num_cleaners,
      price,
      notes,
      cleaner_ids
    } = req.body;

    // Insert booking
    const result = db.prepare(`
      INSERT INTO bookings (
        customer_name, address, phone, email, booking_date, 
        start_time, duration_hours, num_cleaners, price, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer_name, address, phone, email, booking_date,
      start_time, duration_hours, num_cleaners, price, notes
    );

    const bookingId = result.lastInsertRowid;

    // Assign cleaners
    if (cleaner_ids && cleaner_ids.length > 0) {
      const assignStmt = db.prepare('INSERT INTO booking_cleaners (booking_id, cleaner_id) VALUES (?, ?)');
      const assignTransaction = db.transaction((ids) => {
        for (const cleanerId of ids) {
          assignStmt.run(bookingId, cleanerId);
        }
      });
      assignTransaction(cleaner_ids);
    }

    res.status(201).json({ 
      id: bookingId, 
      message: 'Booking created successfully' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update booking
app.put('/api/bookings/:id', (req, res) => {
  try {
    const {
      customer_name,
      address,
      phone,
      email,
      booking_date,
      start_time,
      duration_hours,
      num_cleaners,
      price,
      notes,
      cleaner_ids,
      status
    } = req.body;

    // Update booking
    db.prepare(`
      UPDATE bookings SET
        customer_name = ?, address = ?, phone = ?, email = ?,
        booking_date = ?, start_time = ?, duration_hours = ?,
        num_cleaners = ?, price = ?, notes = ?, status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      customer_name, address, phone, email, booking_date,
      start_time, duration_hours, num_cleaners, price, notes, status,
      req.params.id
    );

    // Update cleaner assignments
    db.prepare('DELETE FROM booking_cleaners WHERE booking_id = ?').run(req.params.id);
    
    if (cleaner_ids && cleaner_ids.length > 0) {
      const assignStmt = db.prepare('INSERT INTO booking_cleaners (booking_id, cleaner_id) VALUES (?, ?)');
      const assignTransaction = db.transaction((ids) => {
        for (const cleanerId of ids) {
          assignStmt.run(req.params.id, cleanerId);
        }
      });
      assignTransaction(cleaner_ids);
    }

    res.json({ message: 'Booking updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete booking
app.delete('/api/bookings/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
    res.json({ message: 'Booking deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === SCHEDULE API ===

// Get weekly schedule
app.get('/api/schedule/week/:date', (req, res) => {
  try {
    const { date } = req.params;
    const startOfWeek = new Date(date);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    
    const startStr = startOfWeek.toISOString().split('T')[0];
    const endStr = endOfWeek.toISOString().split('T')[0];
    
    const query = `
      SELECT 
        b.*,
        GROUP_CONCAT(c.name, ', ') as assigned_cleaners
      FROM bookings b
      LEFT JOIN booking_cleaners bc ON b.id = bc.booking_id
      LEFT JOIN cleaners c ON bc.cleaner_id = c.id
      WHERE b.booking_date BETWEEN ? AND ?
      GROUP BY b.id
      ORDER BY b.booking_date, b.start_time
    `;
    
    const bookings = db.prepare(query).all(startStr, endStr);
    
    res.json({
      week_start: startStr,
      week_end: endStr,
      bookings: bookings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === INCOME API ===

// Get weekly income
app.get('/api/income/weekly/:date', (req, res) => {
  try {
    const { date } = req.params;
    const startOfWeek = new Date(date);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    
    const startStr = startOfWeek.toISOString().split('T')[0];
    const endStr = endOfWeek.toISOString().split('T')[0];
    
    const result = db.prepare(`
      SELECT 
        COUNT(*) as total_bookings,
        SUM(duration_hours) as total_hours,
        SUM(price) as total_income
      FROM bookings
      WHERE booking_date BETWEEN ? AND ?
    `).get(startStr, endStr);
    
    res.json({
      week_start: startStr,
      week_end: endStr,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
});

module.exports = app;
