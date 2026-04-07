const express = require('express');
const path = require('path');
const { initDB, getDB, save, hashPassword, verifyPassword, generateToken, seedUserContent } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH MIDDLEWARE =====
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDB();
  const session = db.exec(`SELECT user_id FROM sessions WHERE token = '${token}'`);
  if (!session.length || !session[0].values.length) return res.status(401).json({ error: 'Invalid session' });
  req.userId = session[0].values[0][0];
  next();
}

// ===== AUTH ROUTES =====
app.post('/api/register', (req, res) => {
  const { email, password, firstName, lastName, phone, brokerage, markets } = req.body;
  if (!email || !password || !firstName) return res.status(400).json({ error: 'Email, password, and first name required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDB();
  const existing = db.exec(`SELECT id FROM users WHERE email = '${email.toLowerCase()}'`);
  if (existing.length && existing[0].values.length) return res.status(409).json({ error: 'Account already exists with this email' });

  const id = generateToken();
  const hash = hashPassword(password);
  const marketsJson = JSON.stringify(markets || []);
  const trialEnds = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  db.run(`INSERT INTO users (id, email, password_hash, first_name, last_name, phone, brokerage, markets, trial_ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email.toLowerCase(), hash, firstName, lastName || '', phone || '', brokerage || '', marketsJson, trialEnds]);

  // Seed content
  seedUserContent(id, marketsJson);

  const token = generateToken();
  db.run(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`, [token, id]);
  save();

  res.json({ token, user: { id, email: email.toLowerCase(), firstName, lastName: lastName || '', markets: markets || [], plan: 'growth' } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDB();
  const result = db.exec(`SELECT id, password_hash, first_name, last_name, email, markets, plan, week_number, day_in_week, trial_ends_at FROM users WHERE email = '${email.toLowerCase()}'`);
  if (!result.length || !result[0].values.length) return res.status(401).json({ error: 'No account found with this email' });

  const row = result[0].values[0];
  const [id, hash, firstName, lastName, userEmail, markets, plan, weekNumber, dayInWeek, trialEnds] = row;

  if (!verifyPassword(password, hash)) return res.status(401).json({ error: 'Incorrect password' });

  const token = generateToken();
  db.run(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`, [token, id]);
  save();

  const trialDaysLeft = Math.max(0, Math.ceil((new Date(trialEnds) - new Date()) / (1000 * 60 * 60 * 24)));

  res.json({
    token,
    user: { id, email: userEmail, firstName, lastName, markets: JSON.parse(markets || '[]'), plan, weekNumber, dayInWeek, trialDaysLeft }
  });
});

app.post('/api/logout', auth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const db = getDB();
  db.run(`DELETE FROM sessions WHERE token = '${token}'`);
  save();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const db = getDB();
  const result = db.exec(`SELECT id, first_name, last_name, email, phone, brokerage, markets, plan, week_number, day_in_week, trial_ends_at, created_at FROM users WHERE id = '${req.userId}'`);
  if (!result.length || !result[0].values.length) return res.status(404).json({ error: 'User not found' });
  const [id, firstName, lastName, email, phone, brokerage, markets, plan, weekNumber, dayInWeek, trialEnds, createdAt] = result[0].values[0];
  const trialDaysLeft = Math.max(0, Math.ceil((new Date(trialEnds) - new Date()) / (1000 * 60 * 60 * 24)));
  res.json({ id, firstName, lastName, email, phone, brokerage, markets: JSON.parse(markets || '[]'), plan, weekNumber, dayInWeek, trialDaysLeft, createdAt });
});

// ===== USER STATE =====
app.patch('/api/me', auth, (req, res) => {
  const db = getDB();
  const allowed = ['first_name', 'last_name', 'phone', 'brokerage', 'markets', 'plan', 'week_number', 'day_in_week'];
  const keyMap = { firstName: 'first_name', lastName: 'last_name', weekNumber: 'week_number', dayInWeek: 'day_in_week' };
  
  for (const [key, val] of Object.entries(req.body)) {
    const col = keyMap[key] || key;
    if (allowed.includes(col)) {
      const v = col === 'markets' ? JSON.stringify(val) : val;
      db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, [v, req.userId]);
    }
  }
  save();
  res.json({ ok: true });
});

// ===== CONTACTS =====
app.get('/api/contacts', auth, (req, res) => {
  const db = getDB();
  const result = db.exec(`SELECT id, first_name, last_name, initials, phone, email, relationship, source, status, notes, tags, priority, last_contact, next_action FROM contacts WHERE user_id = '${req.userId}' ORDER BY 
    CASE status WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, first_name`);
  
  if (!result.length) return res.json([]);
  const cols = result[0].columns;
  const contacts = result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => {
      const key = c.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
      obj[key] = c === 'tags' ? JSON.parse(row[i] || '[]') : row[i];
    });
    return obj;
  });
  res.json(contacts);
});

app.post('/api/contacts', auth, (req, res) => {
  const { firstName, lastName, phone, email, relationship, notes, tags, status, priority } = req.body;
  if (!firstName) return res.status(400).json({ error: 'First name required' });
  
  const initials = (firstName[0] || '') + (lastName?.[0] || '');
  const db = getDB();
  db.run(`INSERT INTO contacts (user_id, first_name, last_name, initials, phone, email, relationship, status, notes, tags, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.userId, firstName, lastName || '', initials.toUpperCase(), phone || '', email || '', relationship || 'Contact', status || 'nurture', notes || '', JSON.stringify(tags || []), priority || 'medium']);
  save();
  
  const inserted = db.exec(`SELECT last_insert_rowid()`);
  const id = inserted[0].values[0][0];
  
  db.run(`INSERT INTO activity (user_id, type, text) VALUES (?, 'contact', ?)`, [req.userId, `Added contact: ${firstName} ${lastName || ''}`]);
  save();
  
  res.json({ id, firstName, lastName: lastName || '', initials: initials.toUpperCase(), phone: phone || '', status: status || 'nurture' });
});

app.patch('/api/contacts/:id', auth, (req, res) => {
  const db = getDB();
  const { status, notes, phone, relationship, lastContact } = req.body;
  if (status) db.run(`UPDATE contacts SET status = ? WHERE id = ? AND user_id = ?`, [status, req.params.id, req.userId]);
  if (notes !== undefined) db.run(`UPDATE contacts SET notes = ? WHERE id = ? AND user_id = ?`, [notes, req.params.id, req.userId]);
  if (phone) db.run(`UPDATE contacts SET phone = ? WHERE id = ? AND user_id = ?`, [phone, req.params.id, req.userId]);
  if (relationship) db.run(`UPDATE contacts SET relationship = ? WHERE id = ? AND user_id = ?`, [relationship, req.params.id, req.userId]);
  if (lastContact) db.run(`UPDATE contacts SET last_contact = ? WHERE id = ? AND user_id = ?`, [lastContact, req.params.id, req.userId]);
  save();
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  const db = getDB();
  db.run(`DELETE FROM contacts WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
  save();
  res.json({ ok: true });
});

// ===== CONTENT =====
app.get('/api/content', auth, (req, res) => {
  const db = getDB();
  const result = db.exec(`SELECT id, title, type, status, channels, town, preview, publish_date FROM content WHERE user_id = '${req.userId}' ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'generating' THEN 1 WHEN 'draft' THEN 2 WHEN 'scheduled' THEN 3 ELSE 4 END`);
  if (!result.length) return res.json([]);
  const cols = result[0].columns;
  res.json(result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => {
      const key = c.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
      obj[key] = c === 'channels' ? JSON.parse(row[i] || '[]') : row[i];
    });
    return obj;
  }));
});

app.patch('/api/content/:id', auth, (req, res) => {
  const db = getDB();
  const { status, title } = req.body;
  if (status === 'published') {
    db.run(`UPDATE content SET status = 'published', publish_date = datetime('now') WHERE id = ? AND user_id = ?`, [req.params.id, req.userId]);
    const piece = db.exec(`SELECT title FROM content WHERE id = ${req.params.id}`);
    const name = piece.length ? piece[0].values[0][0] : 'content';
    db.run(`INSERT INTO activity (user_id, type, text) VALUES (?, 'content', ?)`, [req.userId, `Published: ${name}`]);
  } else if (status) {
    db.run(`UPDATE content SET status = ? WHERE id = ? AND user_id = ?`, [status, req.params.id, req.userId]);
  }
  if (title) db.run(`UPDATE content SET title = ? WHERE id = ? AND user_id = ?`, [title, req.params.id, req.userId]);
  save();
  res.json({ ok: true });
});

app.post('/api/content', auth, (req, res) => {
  const { title, type, channels, town, preview } = req.body;
  const db = getDB();
  db.run(`INSERT INTO content (user_id, title, type, status, channels, town, preview) VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
    [req.userId, title || 'Untitled', type || 'social-post', JSON.stringify(channels || []), town || null, preview || '']);
  save();
  const inserted = db.exec(`SELECT last_insert_rowid()`);
  res.json({ id: inserted[0].values[0][0] });
});

// ===== TASKS =====
app.get('/api/tasks/completed', auth, (req, res) => {
  const db = getDB();
  const { week, day } = req.query;
  let sql = `SELECT task_key FROM tasks_completed WHERE user_id = '${req.userId}'`;
  if (week) sql += ` AND week = ${week}`;
  if (day) sql += ` AND day = ${day}`;
  const result = db.exec(sql);
  if (!result.length) return res.json([]);
  res.json(result[0].values.map(r => r[0]));
});

app.post('/api/tasks/complete', auth, (req, res) => {
  const { week, day, taskKey } = req.body;
  const db = getDB();
  try {
    db.run(`INSERT OR IGNORE INTO tasks_completed (user_id, week, day, task_key) VALUES (?, ?, ?, ?)`, [req.userId, week, day, taskKey]);
    save();
  } catch(e) {}
  res.json({ ok: true });
});

app.post('/api/tasks/uncomplete', auth, (req, res) => {
  const { week, day, taskKey } = req.body;
  const db = getDB();
  db.run(`DELETE FROM tasks_completed WHERE user_id = ? AND week = ? AND day = ? AND task_key = ?`, [req.userId, week, day, taskKey]);
  save();
  res.json({ ok: true });
});

// ===== ACTIVITY =====
app.get('/api/activity', auth, (req, res) => {
  const db = getDB();
  const result = db.exec(`SELECT id, type, text, created_at FROM activity WHERE user_id = '${req.userId}' ORDER BY created_at DESC LIMIT 20`);
  if (!result.length) return res.json([]);
  res.json(result[0].values.map(r => ({ id: r[0], type: r[1], text: r[2], createdAt: r[3] })));
});

// ===== PIPELINE STATS =====
app.get('/api/pipeline', auth, (req, res) => {
  const db = getDB();
  const counts = db.exec(`SELECT status, COUNT(*) as count FROM contacts WHERE user_id = '${req.userId}' GROUP BY status`);
  const stats = { hot: 0, warm: 0, nurture: 0, total: 0 };
  if (counts.length) counts[0].values.forEach(r => { stats[r[0]] = r[1]; stats.total += r[1]; });
  
  const published = db.exec(`SELECT COUNT(*) FROM content WHERE user_id = '${req.userId}' AND status = 'published'`);
  stats.contentPublished = published.length ? published[0].values[0][0] : 0;
  
  const tasks = db.exec(`SELECT COUNT(*) FROM tasks_completed WHERE user_id = '${req.userId}'`);
  stats.tasksCompleted = tasks.length ? tasks[0].values[0][0] : 0;
  
  res.json(stats);
});

// ===== STATIC DATA (coaching, market, drafts) =====
app.get('/api/coaching', (req, res) => {
  res.json({
    scripts: [
      { title: 'Sphere call script', context: 'Friends, family, acquaintances', steps: [
        { label: 'Open casually', text: '"Hey! How\'s everything going?"' },
        { label: 'Mention real estate', text: '"I just started in real estate — working the [your area]."' },
        { label: 'Ask the question', text: '"Know anyone thinking about buying or selling?"' },
        { label: 'If no', text: 'Thank them. They\'ll remember you asked.' },
        { label: 'If yes', text: '"Would you be comfortable making an intro?"' }
      ]},
      { title: 'Home value question', context: 'Most common seller question', steps: [
        { label: 'Pull up data', text: 'Show real numbers on your phone.' },
        { label: 'Give a range', text: '"Homes like yours are selling between $X-$Y."' },
        { label: 'Offer next step', text: '"Free comp analysis — takes me a day."' }
      ]},
      { title: 'Open house script', context: 'Engaging walk-in visitors', steps: [
        { label: 'Welcome', text: '"Hi! Familiar with this neighborhood?"' },
        { label: 'Qualify', text: '"Looking in this area? Timeline?"' },
        { label: 'Capture', text: '"Best number to text you listings?"' }
      ]}
    ],
    objections: [
      { q: '"Wait for rates to drop."', a: 'Every dip brings more buyers and pushes prices up. Buy now with less competition. Refinance later.' },
      { q: '"Why a new agent?"', a: 'Full attention. Real-time data. Same tools. Hungry to make it work for you.' },
      { q: '"Neighbor got more."', a: 'Let me pull that sale. Lot, condition, timing usually explain it. Free comp analysis.' },
      { q: '"Zillow says $X."', a: 'Zillow misses your updates and this month\'s sales. Free comp analysis tells the real story.' },
      { q: '"No exclusive agreement."', a: 'It lets me invest real time into your search. Protects both of us.' }
    ],
    drafts: {
      sphere_initial: "Hey {name}! I just got my real estate license — working the [your area]. If you hear of anyone buying or selling, I'd love the intro!",
      sphere_followup: "Hey {name}, tried to call — nothing urgent! Just catching up.",
      market_response: "Great question! [Your area] is tight right now — homes selling fast, most above asking. Want me to send listings?",
      warm_intro: "Hey {name}, you mentioned {referral} might be thinking about {action}. Comfortable making an intro?",
      open_house_followup: "Hi {name} — great meeting you at {address}! You might like {suggestion}. Want details?",
      social_dm: "Hey {name}! Know anyone in [your area] buying or selling? Building my network.",
      check_in: "Hey {name}! How's the search? New listings in {area} — want them?",
      newsletter: "Hey {name}! I send biweekly market updates — real data. Want in?"
    }
  });
});

// ===== START =====
async function start() {
  await initDB();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Groundwork server running on port ${PORT}`);
    console.log(`Open: http://localhost:${PORT}`);
  });
}

start();
