const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/admin', express.static('admin'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'nassrwrites-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Data file path
const dataPath = path.join(__dirname, 'data', 'content.json');

// Helper functions
function readContent() {
    const data = fs.readFileSync(dataPath, 'utf8');
    return JSON.parse(data);
}

function writeContent(content) {
    fs.writeFileSync(dataPath, JSON.stringify(content, null, 2));
}

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// ============================================
// PUBLIC API ROUTES
// ============================================

// Get all content (public, excludes admin credentials)
app.get('/api/content', (req, res) => {
    try {
        const content = readContent();
        const { admin, ...publicContent } = content;
        res.json(publicContent);
    } catch (error) {
        res.status(500).json({ error: 'Failed to read content' });
    }
});

// Get specific section
app.get('/api/content/:section', (req, res) => {
    try {
        const content = readContent();
        const section = req.params.section;
        
        if (section === 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (content[section]) {
            res.json(content[section]);
        } else {
            res.status(404).json({ error: 'Section not found' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to read content' });
    }
});

// ============================================
// AUTH ROUTES
// ============================================

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const content = readContent();
        
        if (username === content.admin.username) {
            const validPassword = await bcrypt.compare(password, content.admin.passwordHash);
            if (validPassword) {
                req.session.authenticated = true;
                req.session.username = username;
                return res.json({ success: true, message: 'Login successful' });
            }
        }
        
        res.status(401).json({ error: 'Invalid credentials' });
    } catch (error) {
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out' });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
    res.json({ 
        authenticated: !!req.session.authenticated,
        username: req.session.username || null
    });
});

// Change password (authenticated)
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const content = readContent();
        
        const validPassword = await bcrypt.compare(currentPassword, content.admin.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        
        const newHash = await bcrypt.hash(newPassword, 10);
        content.admin.passwordHash = newHash;
        writeContent(content);
        
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ============================================
// ADMIN API ROUTES (Protected)
// ============================================

// Update any section
app.put('/api/admin/content/:section', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const section = req.params.section;
        
        if (section === 'admin') {
            return res.status(403).json({ error: 'Use auth endpoints for admin changes' });
        }
        
        content[section] = req.body;
        writeContent(content);
        
        res.json({ success: true, message: `${section} updated successfully` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update content' });
    }
});

// Update site settings
app.put('/api/admin/site', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.site = { ...content.site, ...req.body };
        writeContent(content);
        res.json({ success: true, message: 'Site settings updated' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update site settings' });
    }
});

// ============================================
// WRITINGS CRUD
// ============================================

app.post('/api/admin/writings', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newWriting = {
            id: 'w' + Date.now(),
            ...req.body
        };
        content.writings.unshift(newWriting);
        writeContent(content);
        res.json({ success: true, writing: newWriting });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add writing' });
    }
});

app.put('/api/admin/writings/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.writings.findIndex(w => w.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'Writing not found' });
        }
        content.writings[index] = { ...content.writings[index], ...req.body };
        writeContent(content);
        res.json({ success: true, writing: content.writings[index] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update writing' });
    }
});

app.delete('/api/admin/writings/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.writings = content.writings.filter(w => w.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Writing deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete writing' });
    }
});

// ============================================
// EVENTS CRUD
// ============================================

app.post('/api/admin/events', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newEvent = {
            id: 'e' + Date.now(),
            ...req.body
        };
        content.events.list.unshift(newEvent);
        writeContent(content);
        res.json({ success: true, event: newEvent });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add event' });
    }
});

app.put('/api/admin/events/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.events.list.findIndex(e => e.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'Event not found' });
        }
        content.events.list[index] = { ...content.events.list[index], ...req.body };
        writeContent(content);
        res.json({ success: true, event: content.events.list[index] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update event' });
    }
});

app.delete('/api/admin/events/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.events.list = content.events.list.filter(e => e.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Event deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ============================================
// SERVICES CRUD
// ============================================

app.post('/api/admin/services', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newService = {
            id: 's' + Date.now(),
            ...req.body
        };
        content.management.services.push(newService);
        writeContent(content);
        res.json({ success: true, service: newService });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add service' });
    }
});

app.put('/api/admin/services/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.management.services.findIndex(s => s.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'Service not found' });
        }
        content.management.services[index] = { ...content.management.services[index], ...req.body };
        writeContent(content);
        res.json({ success: true, service: content.management.services[index] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update service' });
    }
});

app.delete('/api/admin/services/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.management.services = content.management.services.filter(s => s.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Service deleted' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete service' });
    }
});

// Serve the main site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║         NASSR WRITES CMS - Server Running            ║
╠══════════════════════════════════════════════════════╣
║  🌐 Website:     http://localhost:${PORT}               ║
║  🔧 Admin Panel: http://localhost:${PORT}/admin         ║
║                                                      ║
║  Default Login:                                      ║
║  Username: admin                                     ║
║  Password: nassrwrites2024                           ║
║                                                      ║
║  ⚠️  Change password after first login!              ║
╚══════════════════════════════════════════════════════╝
    `);
});
