const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'seat-booking-secret-key-change-in-prod';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Initialize SQLite Database
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

        // 2. Auth Users Table (with role + password)
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password_hash VARCHAR(255),
                role VARCHAR(20) NOT NULL DEFAULT 'user'
            )
        `, () => {
            // Add columns to existing users table if they don't exist (migration)
            db.run(`ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)`, () => {});
            db.run(`ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'`, () => {});

            // Seed default admin account (admin@office.com / Admin@123)
            bcrypt.hash('Admin@123', 10, (err, hash) => {
                if (!err) {
                    db.run(
                        `INSERT OR IGNORE INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
                        ['Admin User', 'admin@office.com', hash, 'admin'],
                        (err) => {
                            if (!err) console.log('Default admin seeded: admin@office.com / Admin@123');
                        }
                    );
                }
            });
        });

        // 3. Bookings Table
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
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'", (err, row) => {
                if (row) {
                    db.run(`
                        INSERT OR IGNORE INTO bookings_v3 (booking_id, seat_id, user_id, booking_date, shift_code, created_at)
                        SELECT booking_id, seat_id, user_id, booking_date, 'APAC', created_at FROM bookings
                    `, () => {
                        db.run(`DROP TABLE bookings`, () => {
                            db.run(`ALTER TABLE bookings_v3 RENAME TO bookings`);
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
                console.log('Seeded 24 office seats');
            }
        });
    });
}

// ------------------- AUTH MIDDLEWARE ------------------- //

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    if (!token) return res.status(401).json({ error: 'Authentication required. Please log in.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired. Please log in again.' });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required for this action.' });
    }
    next();
}

// ------------------- AUTH ENDPOINTS ------------------- //

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) {
        return res.status(400).json({ error: 'Full name, email and password are required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        db.run(
            `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'user')`,
            [full_name, email, hash],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(409).json({ error: 'An account with this email already exists.' });
                    }
                    return res.status(500).json({ error: err.message });
                }
                const token = jwt.sign(
                    { user_id: this.lastID, email, full_name, role: 'user' },
                    JWT_SECRET,
                    { expiresIn: '7d' }
                );
                res.status(201).json({ message: 'Account created!', token, user: { user_id: this.lastID, full_name, email, role: 'user' } });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Registration failed.' });
    }
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        if (!user.password_hash) {
            return res.status(401).json({ error: 'This account has no password set. Contact admin.' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

        const token = jwt.sign(
            { user_id: user.user_id, email: user.email, full_name: user.full_name, role: user.role },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ message: 'Login successful!', token, user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role } });
    });
});

// ------------------- UTILITY FUNCTIONS ------------------- //

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

    if (bookingDateStr < todayStr) return { valid: false, error: `Cannot book for past dates.` };
    if (bookingDateStr > maxDateStr) return { valid: false, error: `Bookings up to 30 days in advance only.` };
    return { valid: true };
}

const SHIFTS = {
    APAC: { code: 'APAC', name: 'APAC Shift', time: '6:00 AM - 3:00 PM' },
    EU:   { code: 'EU',   name: 'EU Shift',   time: '1:00 PM - 10:00 PM' },
    NIGHT:{ code: 'NIGHT',name: 'Night Shift', time: '10:00 PM - 7:00 AM' }
};

// ------------------- SEAT & BOOKING ENDPOINTS ------------------- //

// GET /api/seats/status (public - anyone can view availability)
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
        if (err) return res.status(500).json({ error: err.message });

        const summaryQuery = `SELECT shift_code, COUNT(*) as booked_count FROM bookings WHERE booking_date = ? GROUP BY shift_code`;
        db.all(summaryQuery, [date], (err, summaryRows) => {
            const shiftCounts = { APAC: 0, EU: 0, NIGHT: 0 };
            if (summaryRows) summaryRows.forEach(r => { if (shiftCounts.hasOwnProperty(r.shift_code)) shiftCounts[r.shift_code] = r.booked_count; });

            const maxD = new Date();
            maxD.setDate(maxD.getDate() + 30);

            res.json({
                date, shift,
                shift_info: SHIFTS[shift],
                shift_summary: shiftCounts,
                min_date: todayStr,
                max_date: getFormattedDate(maxD),
                max_advance_days: 30,
                seats: rows
            });
        });
    });
});

// POST /api/bookings (requires login)
app.post('/api/bookings', authenticateToken, (req, res) => {
    const { seat_id, booking_date, shift_code } = req.body;
    const userId = req.user.user_id;
    const fullName = req.user.full_name;

    if (!seat_id || !booking_date) {
        return res.status(400).json({ error: 'Missing required fields: seat_id, booking_date' });
    }

    const shift = (shift_code || 'APAC').toUpperCase();
    if (!SHIFTS[shift]) return res.status(400).json({ error: 'Invalid shift_code.' });

    const dateCheck = validateBookingDate(booking_date);
    if (!dateCheck.valid) return res.status(400).json({ error: dateCheck.error });

    db.run(
        `INSERT INTO bookings (seat_id, user_id, booking_date, shift_code) VALUES (?, ?, ?, ?)`,
        [seat_id, userId, booking_date, shift],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ error: `Seat ${seat_id} is already reserved for ${SHIFTS[shift].name} on ${booking_date}.` });
                }
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({
                message: 'Booking confirmed',
                booking_id: this.lastID,
                seat_id, user_id: userId, full_name: fullName,
                booking_date, shift_code: shift, shift_name: SHIFTS[shift].name, shift_time: SHIFTS[shift].time
            });
        }
    );
});

// DELETE /api/bookings/:id (user can cancel own; admin can cancel any)
app.delete('/api/bookings/:id', authenticateToken, (req, res) => {
    const bookingId = req.params.id;

    // First check who owns this booking
    db.get(`SELECT user_id FROM bookings WHERE booking_id = ?`, [bookingId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Booking not found.' });

        // Allow if admin OR own booking
        if (req.user.role !== 'admin' && row.user_id !== req.user.user_id) {
            return res.status(403).json({ error: 'You can only cancel your own bookings.' });
        }

        db.run(`DELETE FROM bookings WHERE booking_id = ?`, [bookingId], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Booking cancelled successfully', booking_id: bookingId });
        });
    });
});

// GET /api/users/:id/bookings (user sees own; admin sees any)
app.get('/api/users/:id/bookings', authenticateToken, (req, res) => {
    const targetId = req.params.id;
    if (req.user.role !== 'admin' && String(req.user.user_id) !== String(targetId)) {
        return res.status(403).json({ error: 'Access denied.' });
    }

    const today = getFormattedDate(new Date());
    const query = `
        SELECT b.booking_id, b.seat_id, b.booking_date, b.shift_code, b.created_at, u.full_name, u.email
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE b.user_id = ? AND b.booking_date >= ?
        ORDER BY b.booking_date ASC, b.shift_code ASC
    `;
    db.all(query, [targetId, today], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ user_id: targetId, bookings: rows });
    });
});

// ------------------- ADMIN-ONLY ENDPOINTS ------------------- //

// GET /api/admin/users - list all users
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT user_id, full_name, email, role FROM users ORDER BY role, full_name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ users: rows });
    });
});

// PATCH /api/admin/users/:id/role - change user role
app.patch('/api/admin/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be admin or user.' });
    if (String(req.params.id) === String(req.user.user_id)) return res.status(400).json({ error: 'Cannot change your own role.' });

    db.run(`UPDATE users SET role = ? WHERE user_id = ?`, [role, req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: `User role updated to ${role}` });
    });
});

// DELETE /api/admin/users/:id - delete a user
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
    if (String(req.params.id) === String(req.user.user_id)) return res.status(400).json({ error: 'Cannot delete your own account.' });
    db.run(`DELETE FROM users WHERE user_id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found.' });
        res.json({ message: 'User deleted successfully.' });
    });
});

// GET /api/admin/bookings - all bookings (admin only)
app.get('/api/admin/bookings', authenticateToken, requireAdmin, (req, res) => {
    const today = getFormattedDate(new Date());
    db.all(`
        SELECT b.booking_id, b.seat_id, b.booking_date, b.shift_code, b.created_at,
               u.user_id, u.full_name, u.email, u.role
        FROM bookings b
        JOIN users u ON b.user_id = u.user_id
        WHERE b.booking_date >= ?
        ORDER BY b.booking_date ASC, b.shift_code ASC
    `, [today], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ bookings: rows });
    });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 Workspace Booking Server is live!`);
    console.log(`🏠 Local access:    http://localhost:${PORT}`);
    console.log(`🔐 Default Admin:   admin@office.com / Admin@123`);
    console.log(`====================================================`);
});
