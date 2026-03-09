# Nassr Writes CMS

A minimalist content management system for the Nassr Writes cultural portfolio website.

## Features

- **Full Content Control**: Edit all website sections from an intuitive admin panel
- **JSON-Based Storage**: Simple file-based storage (no database required)
- **Secure Admin Access**: Password-protected admin panel with session management
- **Real-Time Updates**: Changes appear on the live site immediately
- **Clean API**: RESTful endpoints for all content operations

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

### 3. Access the Site

- **Website**: http://localhost:3000
- **Admin Panel**: http://localhost:3000/admin

### Default Login Credentials

- **Username**: `admin`
- **Password**: `nassrwrites2024`

⚠️ **Important**: Change the password immediately after first login!

## Project Structure

```
nassrwrites-cms/
├── server.js          # Express.js server
├── package.json       # Node.js dependencies
├── data/
│   └── content.json   # All website content (editable)
├── admin/
│   └── index.html     # Admin dashboard
└── public/
    └── index.html     # Public-facing website
```

## Admin Panel Sections

| Section | What You Can Edit |
|---------|-------------------|
| **Site Settings** | Title, tagline, meta description, email, domain |
| **Hero** | Main headline and positioning statement |
| **About** | Philosophy, bio paragraphs, pull quote, portrait |
| **Practices** | Three main practice areas and philosophy statement |
| **Writings** | Add/edit/delete essays, poems, commentary |
| **Management** | Artist management philosophy, services, alignment criteria |
| **Events** | Past events with dates, venues, descriptions, images |
| **Contact** | Contact intro, body text, inquiry types |

## API Endpoints

### Public (No Auth Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/content` | Get all public content |
| GET | `/api/content/:section` | Get specific section |

### Admin (Auth Required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/api/admin/content/:section` | Update any section |
| POST | `/api/admin/writings` | Add new writing |
| PUT | `/api/admin/writings/:id` | Update writing |
| DELETE | `/api/admin/writings/:id` | Delete writing |
| POST | `/api/admin/events` | Add new event |
| PUT | `/api/admin/events/:id` | Update event |
| DELETE | `/api/admin/events/:id` | Delete event |
| POST | `/api/admin/services` | Add new service |
| PUT | `/api/admin/services/:id` | Update service |
| DELETE | `/api/admin/services/:id` | Delete service |

### Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Login with username/password |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/status` | Check auth status |
| POST | `/api/auth/change-password` | Change admin password |

## Deployment Options

### Option 1: Deploy to Render.com (Recommended)

1. Push code to GitHub
2. Create new Web Service on Render
3. Connect your repository
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Add environment variable: `SESSION_SECRET=your-secret-key`

### Option 2: Deploy to Railway

1. Push code to GitHub
2. Create new project on Railway
3. Connect your repository
4. Railway auto-detects Node.js

### Option 3: Deploy to DigitalOcean App Platform

1. Push code to GitHub
2. Create new App on DigitalOcean
3. Select your repository
4. Configure as Web Service

### Option 4: Self-Hosted (VPS)

```bash
# Clone repository
git clone your-repo-url
cd nassrwrites-cms

# Install dependencies
npm install

# Set environment variables
export SESSION_SECRET=your-secret-key
export NODE_ENV=production
export PORT=3000

# Start with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name nassrwrites

# Or use systemd service
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `SESSION_SECRET` | Session encryption key | (dev key) |
| `NODE_ENV` | Environment mode | development |

## Security Notes

1. **Change the default password** immediately after deployment
2. **Set a strong SESSION_SECRET** in production
3. **Use HTTPS** in production (handled by most hosting platforms)
4. **Backup `data/content.json`** regularly

## Customization

### Adding New Sections

1. Add the section to `data/content.json`
2. Create API endpoint in `server.js` if needed
3. Add form in `admin/index.html`
4. Render section in `public/index.html`

### Changing Colors/Fonts

Edit CSS variables in both `admin/index.html` and `public/index.html`:

```css
:root {
    --color-bg: #FFFFFF;
    --color-cream: #F1EDD8;
    --color-text: #000000;
    --font-serif: 'Radley', Georgia, serif;
    --font-sans: 'DM Sans', -apple-system, sans-serif;
}
```

## License

MIT License - Feel free to use and modify for your projects.

---

Built for [nassrwrites.com](https://nassrwrites.com)
