const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Initialize SQLite Database (In-Memory or Persistent File)
const dbFile = process.env.DB_PATH || path.join(__dirname, 'office_booking.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Failed to connect to database:', err.message);
    } else {
        console.log('Connected to SQLite database at', dbFile);
        initDatabaseSchema();
    }
});

function initDatabaseSchema() {
    db.serialize(() => {
        // 1. Seats Table
        db.run(`
            CREATE TABLE IF NOT EXISTS seats (
                seat_id VARCHAR(10) PRIMARY KEY,
                desk_number INT NOT NULL,
                side_code CHAR(1) NOT NULL,
                position INT NOT NULL
            )
        `);

        // 2. Users Table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL
            )
        `);

        // 3. Bookings Table (Supports seat_id + booking_date + shift_code uniqueness)
        db.run(`
            CREATE TABLE IF NOT EXISTS bookings_v3 (
                booking_id INTEGER PRIMARY KEY AUTOINCREMENT,
                seat_id VARCHAR(10) REFERENCES seats(seat_id),
                user_id INT REFERENCES users(user_id),
                booking_date DATE NOT NULL,
                shift_code VARCHAR(20) NOT NULL DEFAULT 'APAC',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (seat_id, booking_date, shift_code)
            )
        `, () => {
            // Migrate data from old bookings table if exists
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'", (err, row) => {
                if (row) {
                    db.run(`
                        INSERT OR IGNORE INTO bookings_v3 (booking_id, seat_id, user_id, booking_date, shift_code, created_at)
                        SELECT booking_id, seat_id, user_id, booking_date, 'APAC', created_at FROM bookings
                    `, () => {
                        db.run(`DROP TABLE bookings`, () => {
                            db.run(`ALTER TABLE bookings_v3 RENAME TO bookings`);
                            console.log('Migrated bookings schema to support shift_code uniqueness');
                        });
                    });
                } else {
                    db.run(`ALTER TABLE bookings_v3 RENAME TO bookings`);
                }
            });
        });

        // Populate 24 Seats if empty
        db.get('SELECT COUNT(*) as count FROM seats', (err, row) => {
            if (row && row.count === 0) {
                const stmt = db.prepare('INSERT INTO seats (seat_id, desk_number, side_code, position) VALUES (?, ?, ?, ?)');
                for (let desk = 1; desk <= 4; desk++) {
                    ['A', 'B'].forEach(side => {
                        for (let pos = 1; pos <= 3; pos++) {
                            const seatId = `D${desk}-${side}${pos}`;
                            stmt.run(seatId, desk, side, pos);
                        }
                    });
                }
                stmt.finalize();
                console.log('Seeded 24 office seats (D1-A1 to D4-B3)');
            }
        });
    });
}

function getFormattedDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function validateBookingDate(bookingDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = getFormattedDate(today);

    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + 30);
    const maxDateStr = getFormattedDate(maxDate);

    if (bookingDateStr < todayStr) {
        return { valid: false, error: `Cannot book desks for past dates. Selected date: ${bookingDateStr}` };
    }
    if (bookingDateStr > maxDateStr) {
        return { valid: false, error: `Desks can only be booked up to 30 days in advance (Max date: ${maxDateStr}).` };
    }
    return { valid: true };
}

const SHIFTS = {
    APAC: { code: 'APAC', name: 'APAC Shift', time: '6:00 AM - 3:00 PM' },
    EU: { code: 'EU', name: 'EU Shift', time: '1:00 PM - 10:00 PM' },
    NIGHT: { code: 'NIGHT', name: 'Night Shift', time: '10:00 PM - 7:00 AM' }
};

// ------------------- API ENDPOINTS ------------------- //

// 1. GET /api/seats/status?date=YYYY-MM-DD&shift=APAC|EU|NIGHT
app.get('/api/seats/status', (req, res) => {
    const todayStr = getFormattedDate(new Date());
    const date = req.query.date || todayStr;
    const requestedShift = (req.query.shift || 'APAC').toUpperCase();
    const shift = SHIFTS[requestedShift] ? requestedShift : 'APAC';

    const query = `
        SELECT 
            s.seat_id, s.desk_number, s.side_code, s.position,
            b.booking_id, b.booking_date, b.shift_code, u.user_id, u.full_name, u.email,
            CASE WHEN b.booking_id IS NOT NULL THEN 'booked' ELSE 'available' END AS status
        FROM seats s
        LEFT JOIN bookings b ON s.seat_id = b.seat_id AND b.booking_date = ? AND b.shift_code = ?
        LEFT JOIN users u ON b.user_id = u.user_id
        ORDER BY s.desk_number, s.side_code, s.position
    `;

    db.all(query, [date, shift], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        // Summary of bookings per shift for this date
        const summaryQuery = `
            SELECT shift_code, COUNT(*) as booked_count 
            FROM bookings 
            WHERE booking_date = ? 
            GROUP BY shift_code
        `;

        db.all(summaryQuery, [date], (err, summaryRows) => {
            const shiftCounts = { APAC: 0, EU: 0, NIGHT: 0 };
            if (summaryRows) {
                summaryRows.forEach(r => {
                    if (r.shift_code && shiftCounts.hasOwnProperty(r.shift_code)) {
                        shiftCounts[r.shift_code] = r.booked_count;
                    }
                });
            }

            const maxD = new Date();
            maxD.setDate(maxD.getDate() + 30);
            const maxDateStr = getFormattedDate(maxD);

            res.json({
                date,
                shift,
                shift_info: SHIFTS[shift],
                shift_summary: shiftCounts,
                min_date: todayStr,
                max_date: maxDateStr,
                max_advance_days: 30,
                seats: rows
            });
        });
    });
});

// 2. POST /api/bookings - Create a new reservation with shift
app.post('/api/bookings', (req, res) => {
    const { seat_id, full_name, email, booking_date, shift_code } = req.body;

    if (!seat_id || !full_name || !booking_date) {
        return res.status(400).json({ error: 'Missing required fields: seat_id, full_name, booking_date' });
    }

    const shift = (shift_code || 'APAC').toUpperCase();
    if (!SHIFTS[shift]) {
        return res.status(400).json({ error: 'Invalid shift_code. Must be one of: APAC, EU, NIGHT' });
    }

    const dateCheck = validateBookingDate(booking_date);
    if (!dateCheck.valid) {
        return res.status(400).json({ error: dateCheck.error });
    }

    const userEmail = email || `${full_name.toLowerCase().replace(/\s+/g, '.')}@office.com`;

    db.serialize(() => {
        // Upsert User
        db.run(
            `INSERT INTO users (full_name, email) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET full_name=excluded.full_name`,
            [full_name, userEmail],
            function (err) {
                if (err) {
                    return res.status(500).json({ error: 'User registration failed: ' + err.message });
                }

                // Get User ID
                db.get(`SELECT user_id FROM users WHERE email = ?`, [userEmail], (err, userRow) => {
                    if (err || !userRow) {
                        return res.status(500).json({ error: 'User lookup failed' });
                    }

                    const userId = userRow.user_id;

                    // Insert Booking with UNIQUE constraint check (seat_id, booking_date, shift_code)
                    db.run(
                        `INSERT INTO bookings (seat_id, user_id, booking_date, shift_code) VALUES (?, ?, ?, ?)`,
                        [seat_id, userId, booking_date, shift],
                        function (err) {
                            if (err) {
                                if (err.message.includes('UNIQUE constraint failed')) {
                                    return res.status(409).json({ error: `Seat ${seat_id} is already reserved for ${SHIFTS[shift].name} (${SHIFTS[shift].time}) on ${booking_date}.` });
                                }
                                return res.status(500).json({ error: err.message });
                            }

                            res.status(201).json({
                                message: 'Booking confirmed',
                                booking_id: this.lastID,
                                seat_id,
                                user_id: userId,
                                full_name,
                                booking_date,
                                shift_code: shift,
                                shift_name: SHIFTS[shift].name,
                                shift_time: SHIFTS[shift].time
                            });
                        }
                    );
                });
            }
        );
    });
});

// 3. DELETE /api/bookings/:id - Cancel a booking
app.delete('/api/bookings/:id', (req, res) => {
    const bookingId = req.params.id;

    db.run(`DELETE FROM bookings WHERE booking_id = ?`, [bookingId], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json({ message: 'Booking cancelled successfully', booking_id: bookingId });
    });
});

// 4. GET /api/users/:id/bookings - Fetch upcoming desk reservations for user
app.get('/api/users/:id/bookings', (req, res) => {
    const userId = req.params.id;
    const today = new Date().toISOString().split('T')[0];

    const query = `
        SELECT b.booking_id, b.seat_id, b.booking_date, b.shift_code, b.created_at, u.full_name, u.email
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE b.user_id = ? AND b.booking_date >= ?
        ORDER BY b.booking_date ASC, b.shift_code ASC
    `;

    db.all(query, [userId, today], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ user_id: userId, bookings: rows });
    });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server on 0.0.0.0 (Accessible across local network LAN)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 Workspace Booking Server is live!`);
    console.log(`🏠 Local access:    http://localhost:${PORT}`);
    console.log(`🌐 Network access:  http://0.0.0.0:${PORT}`);
    console.log(`====================================================`);
});
