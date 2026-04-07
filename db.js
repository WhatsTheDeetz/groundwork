const initSQL = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, 'groundwork.db');
let db;

async function initDB() {
  const SQL = await initSQL();
  
  // Load existing DB or create new
  let fileBuffer = null;
  try { fileBuffer = fs.readFileSync(DB_PATH); } catch(e) {}
  
  db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
  
  // Create tables
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    brokerage TEXT DEFAULT '',
    markets TEXT DEFAULT '[]',
    plan TEXT DEFAULT 'growth',
    created_at TEXT DEFAULT (datetime('now')),
    trial_ends_at TEXT,
    week_number INTEGER DEFAULT 1,
    day_in_week INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT DEFAULT '',
    initials TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    relationship TEXT DEFAULT 'Contact',
    source TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'nurture',
    notes TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium',
    last_contact TEXT,
    next_action TEXT DEFAULT 'text',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT DEFAULT 'social-post',
    status TEXT DEFAULT 'draft',
    channels TEXT DEFAULT '[]',
    town TEXT,
    preview TEXT DEFAULT '',
    publish_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT DEFAULT 'system',
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks_completed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    week INTEGER NOT NULL,
    day INTEGER NOT NULL,
    task_key TEXT NOT NULL,
    completed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE(user_id, week, day, task_key)
  )`);

  save();
  return db;
}

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getDB() { return db; }

// Simple password hashing (no bcrypt needed — using basic hash for demo)
function hashPassword(pw) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(pw + 'groundwork-salt-2026').digest('hex');
}

function verifyPassword(pw, hash) {
  return hashPassword(pw) === hash;
}

function generateToken() {
  return uuidv4();
}

// Seed initial content for a new user
function seedUserContent(userId, markets) {
  const marketNames = JSON.parse(markets || '[]');
  const town1 = marketNames[0] || 'your first market';
  const town2 = marketNames[1] || 'your second market';
  const town1Short = town1.split(',')[0];
  const town2Short = town2.split(',')[0];

  const contentPieces = [
    { title: `${town1Short} market report — ${new Date().toLocaleString('en-US', {month:'long', year:'numeric'})}`, type: 'market-report', status: 'ready', channels: '["instagram","facebook","blog"]', town: town1Short, preview: `Live market data for ${town1Short}. Review and approve to publish across all channels.` },
    { title: `${town2Short} neighborhood guide`, type: 'neighborhood-guide', status: 'generating', channels: '["blog","email"]', town: town2Short, preview: `Comprehensive guide covering schools, commute, taxes, dining. Building now — ready in 24 hours.` },
    { title: 'Rate watch: what current rates mean for buyers', type: 'commentary', status: 'scheduled', channels: '["instagram","linkedin"]', town: null, preview: 'Analysis of current mortgage rates and what it means for buyers in your market.' },
    { title: `${town1Short}: streets to watch this season`, type: 'social-post', status: 'draft', channels: '["instagram","facebook"]', town: town1Short, preview: `Hot streets with recent sales activity in ${town1Short}.` },
    { title: 'First-time buyer mistakes to avoid', type: 'social-post', status: 'draft', channels: '["instagram","facebook"]', town: null, preview: 'Common mistakes: waiting for rates, skipping pre-approval, trusting online estimates.' },
  ];

  contentPieces.forEach(p => {
    db.run(`INSERT INTO content (user_id, title, type, status, channels, town, preview) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, p.title, p.type, p.status, p.channels, p.town, p.preview]);
  });

  // Log activity
  db.run(`INSERT INTO activity (user_id, type, text) VALUES (?, 'system', ?)`, [userId, `Website building for ${marketNames.join(' and ')}`]);
  db.run(`INSERT INTO activity (user_id, type, text) VALUES (?, 'content', ?)`, [userId, `Market report for ${town1Short} is ready for review`]);

  save();
}

module.exports = { initDB, getDB, save, hashPassword, verifyPassword, generateToken, seedUserContent };
