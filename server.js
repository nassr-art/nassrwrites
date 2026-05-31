require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
const bcrypt     = require('bcryptjs');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const validator  = require('validator');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12;

// ─── Validate required secrets ────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error('FATAL: SESSION_SECRET env var must be set in production');
    process.exit(1);
}

// ─── Data paths ───────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const SEED_PATH = path.join(__dirname, 'data', 'content.json');
const dataPath  = path.join(DATA_DIR, 'content.json');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');

// Seed persistent volume on first boot
if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SEED_PATH)) fs.copyFileSync(SEED_PATH, dataPath);
}
fs.mkdirSync(SESSION_DIR, { recursive: true });

// ─── Atomic, concurrent-safe JSON write queue ─────────────────────────────────
// All writes flow through a single promise chain. Each write goes to a temp
// file first, then is renamed atomically — so a crash never leaves a torn file.
let _writeQueue = Promise.resolve();

async function readContent() {
    const raw = await fs.promises.readFile(dataPath, 'utf8');
    return JSON.parse(raw);
}

function writeContent(content) {
    _writeQueue = _writeQueue.then(async () => {
        const tmp = `${dataPath}.tmp.${Date.now()}`;
        try {
            await fs.promises.writeFile(tmp, JSON.stringify(content, null, 2), 'utf8');
            await fs.promises.rename(tmp, dataPath);
        } catch (err) {
            // Clean up temp file if rename failed
            await fs.promises.unlink(tmp).catch(() => {});
            throw err;
        }
    });
    return _writeQueue;
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:3000'];

app.use(cors({
    origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error('CORS: origin not allowed'))),
    credentials: true,
}));

// ─── Security headers ─────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            // 'unsafe-inline' is required by vanilla-HTML inline <script> blocks.
            // Moving initPage() calls to external .js files would let us drop this.
            scriptSrc:      ["'self'", "'unsafe-inline'"],
            styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:        ["'self'", "https://fonts.gstatic.com"],
            imgSrc:         ["'self'", "data:", "blob:"],
            connectSrc:     ["'self'"],
            objectSrc:      ["'none'"],
            frameAncestors: ["'none'"],
            baseUri:        ["'self'"],
            formAction:     ["'self'"],
        },
    },
}));

// ─── Logging & body parsing ───────────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));

// ─── Static files ─────────────────────────────────────────────────────────────
// Serve only public/ and admin/ — data/ is intentionally never exposed.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ─── Session with file store ──────────────────────────────────────────────────
app.use(session({
    store: new FileStore({ path: SESSION_DIR, ttl: 86400, retries: 1, reapInterval: 3600 }),
    secret: SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
    },
}));

// ─── CSRF (double-submit cookie pattern) ──────────────────────────────────────
// On every request: ensure session has a CSRF secret and mirror it as a
// readable cookie. The JS client reads the cookie and sends it back as a
// header on mutating requests (POST/PUT/DELETE).
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.cookie('XSRF-TOKEN', req.session.csrfToken, {
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        httpOnly: false, // must be JS-readable
    });
    next();
});

function csrfCheck(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const token = req.headers['x-xsrf-token'];
    if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
        return res.status(403).json({ error: 'CSRF validation failed' });
    }
    next();
}

// ─── Rate limiter for login ───────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

app.get('/api/content', async (req, res) => {
    try {
        const content = await readContent();
        const { admin, ...pub } = content;
        if (pub.writings) pub.writings = pub.writings.filter(w => w.status !== 'draft');
        res.json(pub);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read content' });
    }
});

app.get('/api/content/:section', async (req, res) => {
    try {
        const content = await readContent();
        const { section } = req.params;
        if (section === 'admin') return res.status(403).json({ error: 'Access denied' });
        if (content[section] === undefined) return res.status(404).json({ error: 'Section not found' });
        let data = content[section];
        if (section === 'writings' && Array.isArray(data)) {
            data = data.filter(w => w.status !== 'draft');
        }
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read content' });
    }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', loginLimiter, csrfCheck, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        const content = await readContent();
        const valid = username === content.admin.username &&
                      await bcrypt.compare(String(password), content.admin.passwordHash);

        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        // Regenerate session on login to prevent session fixation attacks
        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: 'Session error' });
            req.session.authenticated = true;
            req.session.username = username;
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            res.cookie('XSRF-TOKEN', req.session.csrfToken, {
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                httpOnly: false,
            });
            res.json({ success: true });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/auth/logout', csrfCheck, (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('sid');
        res.json({ success: true });
    });
});

app.get('/api/auth/status', (req, res) => {
    res.json({
        authenticated: !!req.session?.authenticated,
        username: req.session?.username || null,
    });
});

app.post('/api/auth/change-password', requireAuth, csrfCheck, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both passwords are required' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const content = await readContent();
        if (!await bcrypt.compare(String(currentPassword), content.admin.passwordHash)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        content.admin.passwordHash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
        await writeContent(content);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ─── ADMIN API (protected) ────────────────────────────────────────────────────

app.get('/api/admin/content-full', requireAuth, async (req, res) => {
    try {
        const content = await readContent();
        const { admin, ...pub } = content;
        res.json(pub);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read content' });
    }
});

app.put('/api/admin/content/:section', requireAuth, csrfCheck, async (req, res) => {
    try {
        const { section } = req.params;
        if (section === 'admin') {
            return res.status(403).json({ error: 'Use auth endpoints for admin changes' });
        }
        const content = await readContent();
        content[section] = req.body;
        await writeContent(content);
        res.json({ success: true, message: `${section} updated successfully` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update content' });
    }
});

app.put('/api/admin/site', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.site = { ...content.site, ...req.body };
        await writeContent(content);
        res.json({ success: true, message: 'Site settings updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update site settings' });
    }
});

// ─── WRITINGS CRUD ────────────────────────────────────────────────────────────

app.post('/api/admin/writings', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const writing = { id: 'w' + Date.now(), ...req.body };
        content.writings.unshift(writing);
        await writeContent(content);
        res.json({ success: true, writing });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add writing' });
    }
});

app.put('/api/admin/writings/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.writings.findIndex(w => w.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Writing not found' });
        content.writings[idx] = { ...content.writings[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, writing: content.writings[idx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update writing' });
    }
});

app.delete('/api/admin/writings/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.writings = content.writings.filter(w => w.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true, message: 'Writing deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete writing' });
    }
});

// ─── EVENTS CRUD ──────────────────────────────────────────────────────────────

app.post('/api/admin/events', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const event = { id: 'e' + Date.now(), ...req.body };
        content.events.list.unshift(event);
        await writeContent(content);
        res.json({ success: true, event });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add event' });
    }
});

app.put('/api/admin/events/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.events.list.findIndex(e => e.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Event not found' });
        content.events.list[idx] = { ...content.events.list[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, event: content.events.list[idx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update event' });
    }
});

app.delete('/api/admin/events/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.events.list = content.events.list.filter(e => e.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true, message: 'Event deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ─── SERVICES CRUD ────────────────────────────────────────────────────────────

app.post('/api/admin/services', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const service = { id: 's' + Date.now(), ...req.body };
        content.management.services.push(service);
        await writeContent(content);
        res.json({ success: true, service });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add service' });
    }
});

app.put('/api/admin/services/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        const idx = content.management.services.findIndex(s => s.id === req.params.id);
        if (idx === -1) return res.status(404).json({ error: 'Service not found' });
        content.management.services[idx] = { ...content.management.services[idx], ...req.body };
        await writeContent(content);
        res.json({ success: true, service: content.management.services[idx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update service' });
    }
});

app.delete('/api/admin/services/:id', requireAuth, csrfCheck, async (req, res) => {
    try {
        const content = await readContent();
        content.management.services = content.management.services.filter(s => s.id !== req.params.id);
        await writeContent(content);
        res.json({ success: true, message: 'Service deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete service' });
    }
});

// ─── NEWSLETTER ───────────────────────────────────────────────────────────────

app.post('/api/newsletter/subscribe', csrfCheck, async (req, res) => {
    try {
        const rawEmail = String(req.body.email || '').trim();
        const rawName  = String(req.body.name  || '').trim().slice(0, 100);

        if (!rawEmail || !validator.isEmail(rawEmail)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }

        const email = validator.normalizeEmail(rawEmail) || rawEmail.toLowerCase();
        const content = await readContent();
        if (!content.newsletter) content.newsletter = { subscribers: [] };

        if (content.newsletter.subscribers.some(s => s.email === email)) {
            return res.status(409).json({ error: 'This email is already subscribed.' });
        }

        content.newsletter.subscribers.push({
            id: 'sub_' + Date.now(),
            name: rawName,
            email,
            subscribedAt: new Date().toISOString(),
        });
        await writeContent(content);
        res.json({ message: "You're on the list. Thank you." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
    }
});

app.get('/api/admin/newsletter/subscribers', requireAuth, async (req, res) => {
    try {
        const content = await readContent();
        res.json(content.newsletter?.subscribers || []);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
});

// ─── Page routes ──────────────────────────────────────────────────────────────

const PAGES = {
    '/':           'index',
    '/about':      'about',
    '/writing':    'writing',
    '/management': 'management',
    '/events':     'events',
    '/contact':    'contact',
};

Object.entries(PAGES).forEach(([route, file]) => {
    app.get(route, (req, res) =>
        res.sendFile(path.join(__dirname, 'public', `${file}.html`)));
});

app.get('/subscribe', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'subscribe.html')));

const WRITING_CATEGORIES = ['essays', 'poetry', 'commentary'];
WRITING_CATEGORIES.forEach(cat => {
    app.get(`/writing/${cat}`, (req, res) =>
        res.sendFile(path.join(__dirname, 'public', 'writing-category.html')));
});

app.get('/writing/:category/:slug', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'writing-detail.html')));

app.get('/admin', (req, res) =>
    res.sendFile(path.join(__dirname, 'admin', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`NassrWrites CMS running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
});
