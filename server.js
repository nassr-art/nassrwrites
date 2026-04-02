require('dotenv').config();

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Storage for uploads ────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    }
});

// ─── Rate limiters ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts, please try again later.' }
});

const newsletterLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many subscription attempts, please try again later.' }
});

// ─── Core middleware ─────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('dev'));
app.use(cors());
app.use(express.json());
app.use(express.static('public', {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
}));
app.use('/admin', express.static('admin'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'nassrwrites-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// ─── Data helpers ────────────────────────────────────────────────────────────
const dataPath = path.join(__dirname, 'data', 'content.json');

function readContent() {
    return JSON.parse(fs.readFileSync(dataPath, 'utf8'));
}

function writeContent(content) {
    fs.writeFileSync(dataPath, JSON.stringify(content, null, 2));
}

function wordCount(text) {
    return (text || '').split(/\s+/).filter(Boolean).length;
}

function readingTime(text) {
    return Math.max(1, Math.ceil(wordCount(text) / 200));
}

// ─── Auth middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ============================================================
// PUBLIC API ROUTES
// ============================================================

app.get('/api/content', (req, res) => {
    try {
        const content = readContent();
        const { admin, ...publicContent } = content;
        if (publicContent.writings) {
            publicContent.writings = publicContent.writings
                .filter(w => w.status !== 'draft')
                .map(w => ({ ...w, readingTime: readingTime(w.fullContent || w.description || '') }));
        }
        res.json(publicContent);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read content' });
    }
});

app.get('/api/content/:section', (req, res) => {
    try {
        const content = readContent();
        const section = req.params.section;
        if (section === 'admin') return res.status(403).json({ error: 'Access denied' });
        if (content[section] === undefined) return res.status(404).json({ error: 'Section not found' });
        let data = content[section];
        if (section === 'writings' && Array.isArray(data)) {
            data = data
                .filter(w => w.status !== 'draft')
                .map(w => ({ ...w, readingTime: readingTime(w.fullContent || w.description || '') }));
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read content' });
    }
});

// ============================================================
// AUTH ROUTES
// ============================================================

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const content = readContent();
        if (username === content.admin.username) {
            const valid = await bcrypt.compare(password, content.admin.passwordHash);
            if (valid) {
                req.session.authenticated = true;
                req.session.username = username;
                return res.json({ success: true, message: 'Login successful' });
            }
        }
        res.status(401).json({ error: 'Invalid credentials' });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: !!req.session.authenticated, username: req.session.username || null });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const content = readContent();
        const valid = await bcrypt.compare(currentPassword, content.admin.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        content.admin.passwordHash = await bcrypt.hash(newPassword, 10);
        writeContent(content);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ============================================================
// ADMIN API ROUTES (Protected)
// ============================================================

app.get('/api/admin/content-full', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const { admin, ...publicContent } = content;
        res.json(publicContent);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read content' });
    }
});

app.put('/api/admin/content/:section', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const section = req.params.section;
        if (section === 'admin') return res.status(403).json({ error: 'Use auth endpoints for admin changes' });
        content[section] = req.body;
        writeContent(content);
        res.json({ success: true, message: `${section} updated successfully` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update content' });
    }
});

app.put('/api/admin/site', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.site = { ...content.site, ...req.body };
        writeContent(content);
        res.json({ success: true, message: 'Site settings updated' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update site settings' });
    }
});

// ─── Image upload ────────────────────────────────────────────────────────────
app.post('/api/admin/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: '/uploads/' + req.file.filename });
});

// ============================================================
// WRITINGS CRUD
// ============================================================

app.post('/api/admin/writings', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newWriting = { id: 'w' + Date.now(), ...req.body };
        content.writings.unshift(newWriting);
        writeContent(content);
        res.json({ success: true, writing: newWriting });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add writing' });
    }
});

app.put('/api/admin/writings/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.writings.findIndex(w => w.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Writing not found' });
        content.writings[index] = { ...content.writings[index], ...req.body };
        writeContent(content);
        res.json({ success: true, writing: content.writings[index] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update writing' });
    }
});

app.delete('/api/admin/writings/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.writings = content.writings.filter(w => w.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Writing deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete writing' });
    }
});

// ============================================================
// EVENTS CRUD
// ============================================================

app.post('/api/admin/events', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newEvent = { id: 'e' + Date.now(), ...req.body };
        content.events.list.unshift(newEvent);
        writeContent(content);
        res.json({ success: true, event: newEvent });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add event' });
    }
});

app.put('/api/admin/events/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.events.list.findIndex(e => e.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Event not found' });
        content.events.list[index] = { ...content.events.list[index], ...req.body };
        writeContent(content);
        res.json({ success: true, event: content.events.list[index] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update event' });
    }
});

app.delete('/api/admin/events/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.events.list = content.events.list.filter(e => e.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Event deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ============================================================
// SERVICES CRUD
// ============================================================

app.post('/api/admin/services', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const newService = { id: 's' + Date.now(), ...req.body };
        content.management.services.push(newService);
        writeContent(content);
        res.json({ success: true, service: newService });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add service' });
    }
});

app.put('/api/admin/services/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        const index = content.management.services.findIndex(s => s.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Service not found' });
        content.management.services[index] = { ...content.management.services[index], ...req.body };
        writeContent(content);
        res.json({ success: true, service: content.management.services[index] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update service' });
    }
});

app.delete('/api/admin/services/:id', requireAuth, (req, res) => {
    try {
        const content = readContent();
        content.management.services = content.management.services.filter(s => s.id !== req.params.id);
        writeContent(content);
        res.json({ success: true, message: 'Service deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete service' });
    }
});

// ============================================================
// NEWSLETTER
// ============================================================

app.post('/api/newsletter/subscribe', newsletterLimiter, (req, res) => {
    try {
        const { name, email } = req.body;
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }
        const content = readContent();
        if (!content.newsletter) content.newsletter = { subscribers: [] };
        if (content.newsletter.subscribers.some(s => s.email === email)) {
            return res.status(409).json({ error: 'This email is already subscribed.' });
        }
        content.newsletter.subscribers.push({
            id: 'sub_' + Date.now(),
            name: name || '',
            email,
            subscribedAt: new Date().toISOString()
        });
        writeContent(content);
        res.json({ message: "You're on the list. Thank you." });
    } catch (err) {
        res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
    }
});

app.get('/api/admin/newsletter/subscribers', requireAuth, (req, res) => {
    try {
        const content = readContent();
        res.json(content.newsletter?.subscribers || []);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
});

// ============================================================
// RSS FEED
// ============================================================

app.get('/feed.xml', (req, res) => {
    try {
        const content = readContent();
        const site = content.site;
        const writings = (content.writings || []).filter(w => w.status === 'published');
        const baseUrl = `https://${site.domain}`;

        const items = writings.map(w => `
  <item>
    <title><![CDATA[${w.title}]]></title>
    <link>${baseUrl}${w.link}</link>
    <guid isPermaLink="true">${baseUrl}${w.link}</guid>
    <description><![CDATA[${w.excerpt || w.description || ''}]]></description>
    <category><![CDATA[${w.type || w.category || ''}]]></category>
    <pubDate>${new Date(w.date).toString() !== 'Invalid Date' ? new Date(w.date).toUTCString() : w.date}</pubDate>
  </item>`).join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title><![CDATA[${site.title}]]></title>
  <link>${baseUrl}</link>
  <description><![CDATA[${site.description}]]></description>
  <language>en-us</language>
  <atom:link href="${baseUrl}/feed.xml" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>`;

        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        res.send(xml);
    } catch (err) {
        res.status(500).send('Failed to generate feed');
    }
});

// ============================================================
// SITEMAP
// ============================================================

app.get('/sitemap.xml', (req, res) => {
    try {
        const content = readContent();
        const baseUrl = `https://${content.site.domain}`;
        const staticRoutes = ['/', '/about', '/writing', '/management', '/events', '/contact', '/subscribe'];
        const writingRoutes = (content.writings || [])
            .filter(w => w.status === 'published' && w.link)
            .map(w => w.link);

        const urls = [...staticRoutes, ...writingRoutes].map(loc => `
  <url>
    <loc>${baseUrl}${loc}</loc>
    <changefreq>${loc === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${loc === '/' ? '1.0' : '0.8'}</priority>
  </url>`).join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

        res.set('Content-Type', 'application/xml; charset=utf-8');
        res.send(xml);
    } catch (err) {
        res.status(500).send('Failed to generate sitemap');
    }
});

// ============================================================
// PAGE ROUTES
// ============================================================

const pages = {
    '/': 'index', '/about': 'about', '/writing': 'writing',
    '/management': 'management', '/events': 'events', '/contact': 'contact'
};
Object.entries(pages).forEach(([route, file]) => {
    app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', `${file}.html`)));
});

app.get('/subscribe', (req, res) => res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));

const WRITING_CATEGORIES = ['essays', 'poetry', 'commentary'];
WRITING_CATEGORIES.forEach(cat => {
    app.get(`/writing/${cat}`, (req, res) => res.sendFile(path.join(__dirname, 'public', 'writing-category.html')));
});

app.get('/writing/:category/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'writing-detail.html')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║       NASSR WRITES CMS v2 — Server Running           ║
╠══════════════════════════════════════════════════════╣
║  Website:     http://localhost:${PORT}                  ║
║  Admin Panel: http://localhost:${PORT}/admin            ║
║  RSS Feed:    http://localhost:${PORT}/feed.xml         ║
║  Sitemap:     http://localhost:${PORT}/sitemap.xml      ║
║                                                      ║
║  Default Login:  admin / nassrwrites2024             ║
║  Change password after first login!                  ║
╚══════════════════════════════════════════════════════╝
    `);
});
