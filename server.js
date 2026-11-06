
require('dotenv').config();

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const redis = require('redis');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==========================================
// 1. MIDDLEWARE AND STATIC FILES
// ==========================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 2. MYSQL DATABASE CONNECTION
// ==========================================

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// 3. REDIS PUB/SUB CONNECTION
// ==========================================

const redisPublisher = redis.createClient({
    url: process.env.REDIS_URL
});

const redisSubscriber = redis.createClient({
    url: process.env.REDIS_URL
});

redisPublisher.on('error', (err) => {
    console.error('Redis Publisher Error:', err);
});

redisSubscriber.on('error', (err) => {
    console.error('Redis Subscriber Error:', err);
});

// Subscribe once when the server starts.
// All connected browsers receive the events.

async function connectRedis() {
    await redisPublisher.connect();
    await redisSubscriber.connect();

    console.log('Connected to Redis Message Broker');

    // Listen for user login events
    await redisSubscriber.subscribe(
        'user_login_events',
        (message) => {
            try {
                io.emit('user_logged_in', JSON.parse(message));
            } catch (err) {
                console.error('Login event error:', err);
            }
        }
    );

    // Listen for admin announcements
    await redisSubscriber.subscribe(
        'admin_broadcast',
        (message) => {
            try {
                io.emit('new_announcement', JSON.parse(message));
            } catch (err) {
                console.error('Broadcast event error:', err);
            }
        }
    );
}

// ==========================================
// 4. AUTHENTICATION MIDDLEWARE
// ==========================================

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];

    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({
            error: 'Access Denied: No Token Provided'
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({
                error: 'Invalid Token'
            });
        }

        req.user = user;
        next();
    });
};

// Admin-only middleware
const isAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
            error: 'Admin privileges required'
        });
    }

    next();
};

// ==========================================
// 5. REGISTRATION ROUTE
// ==========================================

app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({
            error: 'All fields are required'
        });
    }

    try {
        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Public registration always creates a normal user
        await pool.execute(
            `INSERT INTO users
            (name, email, password, role)
            VALUES (?, ?, ?, ?)`,
            [name, email, hashedPassword, 'user']
        );

        return res.status(201).json({
            message: 'Registration successful'
        });

    } catch (err) {
        console.error('REGISTER ERROR:', err);

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Email already exists'
            });
        }

        return res.status(500).json({
            error: 'Registration failed',
            details: err.message
        });
    }
});

// ==========================================
// 6. LOGIN ROUTE
// ==========================================

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email and password are required'
        });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM users WHERE email = ?',
            [email]
        );

        const user = rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                error: 'Invalid email or password'
            });
        }

        // Generate JWT
        const token = jwt.sign(
            {
                id: user.id,
                role: user.role,
                name: user.name
            },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        // Save login history
        await pool.execute(
            'INSERT INTO login_logs (user_id) VALUES (?)',
            [user.id]
        );

        // Publish login event to Redis
        await redisPublisher.publish(
            'user_login_events',
            JSON.stringify({
                name: user.name,
                role: user.role,
                time: new Date().toLocaleTimeString()
            })
        );

        return res.status(200).json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            redirectTo: `/${user.role}.html`
        });

    } catch (err) {
        console.error('LOGIN ERROR:', err);

        return res.status(500).json({
            error: 'Login failed',
            details: err.message
        });
    }
});

// ==========================================
// 7. GET ALL USERS (ADMIN ONLY)
// ==========================================

app.get('/api/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT id, name, email, role FROM users'
        );

        return res.status(200).json(rows);

    } catch (err) {
        console.error('GET USERS ERROR:', err);

        return res.status(500).json({
            error: 'Failed to retrieve users'
        });
    }
});

// ==========================================
// 8. UPDATE USER (ADMIN ONLY)
// ==========================================

app.put('/api/users/:id', authenticateToken, isAdmin, async (req, res) => {
    const { name, email, role } = req.body;

    if (!name || !email || !role) {
        return res.status(400).json({
            error: 'Name, email, and role are required'
        });
    }

    if (!['admin', 'staff', 'user'].includes(role)) {
        return res.status(400).json({
            error: 'Invalid role'
        });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE users
            SET name = ?, email = ?, role = ?
            WHERE id = ?`,
            [name, email, role, req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: 'User not found'
            });
        }

        return res.status(200).json({
            message: 'User updated successfully'
        });

    } catch (err) {
        console.error('UPDATE USER ERROR:', err);

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Email already exists'
            });
        }

        return res.status(500).json({
            error: 'Update failed'
        });
    }
});

// ==========================================
// 9. DELETE USER (ADMIN ONLY)
// ==========================================

app.delete('/api/users/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        // Prevent Admin from deleting their own account
        if (Number(req.params.id) === Number(req.user.id)) {
            return res.status(403).json({
                error: 'You cannot delete your own admin account'
            });
        }

        const [result] = await pool.execute(
            'DELETE FROM users WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                error: 'User not found'
            });
        }

        return res.status(204).send();

    } catch (err) {
        console.error('DELETE USER ERROR:', err);

        return res.status(500).json({
            error: 'Delete failed'
        });
    }
});

// ==========================================
// 10. PROFILE UPDATE
// ==========================================

app.put('/api/profile', authenticateToken, async (req, res) => {
    const {
        name,
        email,
        currentPassword,
        newPassword
    } = req.body;

    if (!name || !email) {
        return res.status(400).json({
            error: 'Name and email are required'
        });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM users WHERE id = ?',
            [req.user.id]
        );

        const user = rows[0];

        if (!user) {
            return res.status(404).json({
                error: 'User not found'
            });
        }

        let updateQuery =
            'UPDATE users SET name = ?, email = ? WHERE id = ?';

        let params = [name, email, req.user.id];

        // Change password only when a new password is provided
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({
                    error: 'Current password required'
                });
            }

            const match = await bcrypt.compare(
                currentPassword,
                user.password
            );

            if (!match) {
                return res.status(401).json({
                    error: 'Current password is incorrect'
                });
            }

            const hashedNewPassword = await bcrypt.hash(newPassword, 10);

            updateQuery =
                `UPDATE users
                SET name = ?, email = ?, password = ?
                WHERE id = ?`;

            params = [
                name,
                email,
                hashedNewPassword,
                req.user.id
            ];
        }

        await pool.execute(updateQuery, params);

        return res.status(200).json({
            message: 'Profile updated successfully',
            name,
            email
        });

    } catch (err) {
        console.error('PROFILE UPDATE ERROR:', err);

        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                error: 'Email already in use'
            });
        }

        return res.status(500).json({
            error: 'Profile update failed'
        });
    }
});

// ==========================================
// 11. ADMIN BROADCAST
// ==========================================

app.post('/api/broadcast', authenticateToken, isAdmin, async (req, res) => {
    const { message } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({
            error: 'Announcement message is required'
        });
    }

    try {
        const [result] = await pool.execute(
            'INSERT INTO announcements (message) VALUES (?)',
            [message]
        );

        const [rows] = await pool.execute(
            'SELECT * FROM announcements WHERE id = ?',
            [result.insertId]
        );

        // Publish announcement to Redis
        await redisPublisher.publish(
            'admin_broadcast',
            JSON.stringify(rows[0])
        );

        return res.status(201).json(rows[0]);

    } catch (err) {
        console.error('BROADCAST ERROR:', err);

        return res.status(500).json({
            error: 'Broadcast failed'
        });
    }
});

// ==========================================
// 12. SOCKET.IO CONNECTION
// ==========================================

io.on('connection', (socket) => {
    console.log('A client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('A client disconnected:', socket.id);
    });
});

// ==========================================
// 13. START SERVER
// ==========================================

async function startServer() {
    try {
        // Test MySQL connection
        await pool.query('SELECT 1');

        console.log('Connected to MySQL Database');

        // Connect Redis and subscribe to events
        await connectRedis();

        // Start Express server
        const PORT = process.env.PORT || 3000;

        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error('SERVER START ERROR:', err);
        process.exit(1);
    }
}

startServer();
