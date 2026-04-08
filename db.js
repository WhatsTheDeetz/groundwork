const initSQL = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const DB_PATH = path.join(__dirname, 'groundwork.db');
let db;

async function initDB() {
  const SQL = await initSQL();
  let buf = null;
  try { buf = fs.readFileSync(DB_PATH); } catch(e) {}
  db = buf ? new SQL.Database(buf) : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT DEFAULT '', phone TEXT DEFAULT '',
    brokerage TEXT DEFAULT '', markets TEXT DEFAULT '[]', bio TEXT DEFAULT '',
    linkedin_url TEXT DEFAULT '', photo_data TEXT DEFAULT '',
    onboarding_complete INTEGER DEFAULT 0, plan TEXT DEFAULT 'growth',
    created_at TEXT DEFAULT (datetime('now')), trial_ends_at TEXT,
    week_number INTEGER DEFAULT 1, day_in_week INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT DEFAULT '', initials TEXT DEFAULT '',
    phone TEXT DEFAULT '', email TEXT DEFAULT '', relationship TEXT DEFAULT 'Contact',
    contact_type TEXT DEFAULT 'unknown', source TEXT DEFAULT 'manual',
    status TEXT DEFAULT 'nurture', notes TEXT DEFAULT '', tags TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'medium', last_contact TEXT, next_action TEXT DEFAULT 'text',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS contact_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, contact_id INTEGER NOT NULL,
    type TEXT NOT NULL, notes TEXT DEFAULT '', outcome TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, title TEXT NOT NULL,
    type TEXT DEFAULT 'social-post', status TEXT DEFAULT 'draft', channels TEXT DEFAULT '[]',
    town TEXT, preview TEXT DEFAULT '', publish_date TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT DEFAULT 'system',
    text TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks_completed (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, week INTEGER NOT NULL,
    day INTEGER NOT NULL, task_key TEXT NOT NULL, completed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, week, day, task_key)
  )`);

  // Migrations for existing DBs
  const migrations = [
    `ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN linkedin_url TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN photo_data TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN onboarding_complete INTEGER DEFAULT 0`,
    `ALTER TABLE contacts ADD COLUMN contact_type TEXT DEFAULT 'unknown'`
  ];
  migrations.forEach(sql => { try { db.run(sql); } catch(e) {} });
  save();
  return db;
}

function save() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function getDB() { return db; }
function hashPassword(pw) { return require('crypto').createHash('sha256').update(pw+'groundwork-salt-2026').digest('hex'); }
function verifyPassword(pw, hash) { return hashPassword(pw)===hash; }
function generateToken() { return uuidv4(); }

function seedUserContent(userId, markets) {
  const names = JSON.parse(markets||'[]');
  const t1 = (names[0]||'your market').split(',')[0];
  const t2 = (names[1]||'your second market').split(',')[0];
  const mo = new Date().toLocaleString('en-US',{month:'long',year:'numeric'});
  const pieces = [
    {title:`${t1} market report — ${mo}`,type:'market-report',st:'ready',ch:'["instagram","facebook","blog"]',tw:t1,pv:`Live data for ${t1}. Approve to publish.`},
    {title:`${t2} neighborhood guide`,type:'neighborhood-guide',st:'generating',ch:'["blog","email"]',tw:t2,pv:`Schools, commute, taxes. Ready in 24 hours.`},
    {title:'Rate watch: current rates for buyers',type:'commentary',st:'scheduled',ch:'["instagram","linkedin"]',tw:null,pv:'Mortgage rate analysis for your market.'},
    {title:`${t1}: streets to watch`,type:'social-post',st:'draft',ch:'["instagram","facebook"]',tw:t1,pv:`Hot streets in ${t1}.`},
    {title:'First-time buyer mistakes',type:'social-post',st:'draft',ch:'["instagram","facebook"]',tw:null,pv:'Common mistakes new buyers make.'}
  ];
  pieces.forEach(p => db.run(`INSERT INTO content (user_id,title,type,status,channels,town,preview) VALUES (?,?,?,?,?,?,?)`,[userId,p.title,p.type,p.st,p.ch,p.tw,p.pv]));
  db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'system',?)`,[userId,`Website building for ${names.join(' and ')}`]);
  db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'content',?)`,[userId,`Market report for ${t1} ready for review`]);
  save();
}

module.exports = { initDB, getDB, save, hashPassword, verifyPassword, generateToken, seedUserContent };
