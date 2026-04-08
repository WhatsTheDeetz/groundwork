const express = require('express');
const path = require('path');
const { initDB, getDB, save, hashPassword, verifyPassword, generateToken, seedUserContent } = require('./db');
const app = express();
app.use(express.json({ limit: '10mb' })); // Larger limit for photo uploads
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','');
  if (!token) return res.status(401).json({error:'Not authenticated'});
  const db = getDB();
  const s = db.exec(`SELECT user_id FROM sessions WHERE token='${token}'`);
  if (!s.length||!s[0].values.length) return res.status(401).json({error:'Invalid session'});
  req.userId = s[0].values[0][0];
  next();
}

// === AUTH ===
app.post('/api/register', (req, res) => {
  const {email,password,firstName,lastName,phone,brokerage,markets,bio,linkedinUrl} = req.body;
  if (!email||!password||!firstName) return res.status(400).json({error:'Email, password, and first name required'});
  if (password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
  const db = getDB();
  const ex = db.exec(`SELECT id FROM users WHERE email='${email.toLowerCase()}'`);
  if (ex.length&&ex[0].values.length) return res.status(409).json({error:'Account already exists'});
  const id = generateToken(), hash = hashPassword(password);
  const mj = JSON.stringify(markets||[]);
  const te = new Date(Date.now()+90*24*60*60*1000).toISOString();
  db.run(`INSERT INTO users (id,email,password_hash,first_name,last_name,phone,brokerage,markets,bio,linkedin_url,trial_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id,email.toLowerCase(),hash,firstName,lastName||'',phone||'',brokerage||'',mj,bio||'',linkedinUrl||'',te]);
  seedUserContent(id, mj);
  const token = generateToken();
  db.run(`INSERT INTO sessions (token,user_id) VALUES (?,?)`,[token,id]);
  save();
  res.json({token,user:{id,email:email.toLowerCase(),firstName,lastName:lastName||'',markets:markets||[],plan:'growth',onboardingComplete:0}});
});

app.post('/api/login', (req, res) => {
  const {email,password} = req.body;
  if (!email||!password) return res.status(400).json({error:'Email and password required'});
  const db = getDB();
  const r = db.exec(`SELECT id,password_hash,first_name,last_name,email,markets,plan,week_number,day_in_week,trial_ends_at,bio,linkedin_url,onboarding_complete FROM users WHERE email='${email.toLowerCase()}'`);
  if (!r.length||!r[0].values.length) return res.status(401).json({error:'No account found'});
  const [id,hash,fn,ln,em,mk,pl,wn,dw,te,bio,li,ob] = r[0].values[0];
  if (!verifyPassword(password,hash)) return res.status(401).json({error:'Incorrect password'});
  const token = generateToken();
  db.run(`INSERT INTO sessions (token,user_id) VALUES (?,?)`,[token,id]);
  save();
  const tdl = Math.max(0,Math.ceil((new Date(te)-new Date())/(1000*60*60*24)));
  res.json({token,user:{id,email:em,firstName:fn,lastName:ln,markets:JSON.parse(mk||'[]'),plan:pl,weekNumber:wn,dayInWeek:dw,trialDaysLeft:tdl,bio,linkedinUrl:li,onboardingComplete:ob}});
});

app.post('/api/logout', auth, (req, res) => {
  const db = getDB();
  db.run(`DELETE FROM sessions WHERE token='${req.headers.authorization?.replace('Bearer ','')}'`);
  save(); res.json({ok:true});
});

app.get('/api/me', auth, (req, res) => {
  const db = getDB();
  const r = db.exec(`SELECT id,first_name,last_name,email,phone,brokerage,markets,plan,week_number,day_in_week,trial_ends_at,created_at,bio,linkedin_url,photo_data,onboarding_complete FROM users WHERE id='${req.userId}'`);
  if (!r.length||!r[0].values.length) return res.status(404).json({error:'User not found'});
  const [id,fn,ln,em,ph,br,mk,pl,wn,dw,te,ca,bio,li,photo,ob] = r[0].values[0];
  const tdl = Math.max(0,Math.ceil((new Date(te)-new Date())/(1000*60*60*24)));
  res.json({id,firstName:fn,lastName:ln,email:em,phone:ph,brokerage:br,markets:JSON.parse(mk||'[]'),plan:pl,weekNumber:wn,dayInWeek:dw,trialDaysLeft:tdl,createdAt:ca,bio:bio||'',linkedinUrl:li||'',photoData:photo||'',onboardingComplete:ob||0});
});

app.patch('/api/me', auth, (req, res) => {
  const db = getDB();
  const map = {firstName:'first_name',lastName:'last_name',weekNumber:'week_number',dayInWeek:'day_in_week',linkedinUrl:'linkedin_url',photoData:'photo_data',onboardingComplete:'onboarding_complete'};
  const allowed = ['first_name','last_name','phone','brokerage','markets','plan','week_number','day_in_week','bio','linkedin_url','photo_data','onboarding_complete'];
  for (const [k,v] of Object.entries(req.body)) {
    const col = map[k]||k;
    if (allowed.includes(col)) db.run(`UPDATE users SET ${col}=? WHERE id=?`,[col==='markets'?JSON.stringify(v):v,req.userId]);
  }
  save(); res.json({ok:true});
});

// === CONTACTS ===
app.get('/api/contacts', auth, (req, res) => {
  const db = getDB();
  const r = db.exec(`SELECT id,first_name,last_name,initials,phone,email,relationship,contact_type,source,status,notes,tags,priority,last_contact,next_action FROM contacts WHERE user_id='${req.userId}' ORDER BY CASE status WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, first_name`);
  if (!r.length) return res.json([]);
  res.json(r[0].values.map(row => {
    const o = {}; r[0].columns.forEach((c,i) => { const k = c.replace(/_([a-z])/g,(_,l)=>l.toUpperCase()); o[k] = (c==='tags'?JSON.parse(row[i]||'[]'):row[i]); }); return o;
  }));
});

app.post('/api/contacts', auth, (req, res) => {
  const {firstName,lastName,phone,email,relationship,notes,tags,status,priority,contactType,source} = req.body;
  if (!firstName) return res.status(400).json({error:'First name required'});
  const ini = ((firstName[0]||'')+(lastName?.[0]||'')).toUpperCase();
  const db = getDB();
  db.run(`INSERT INTO contacts (user_id,first_name,last_name,initials,phone,email,relationship,contact_type,source,status,notes,tags,priority) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.userId,firstName,lastName||'',ini,phone||'',email||'',relationship||'Contact',contactType||'unknown',source||'manual',status||'nurture',notes||'',JSON.stringify(tags||[]),priority||'medium']);
  save();
  const ins = db.exec(`SELECT last_insert_rowid()`);
  db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'contact',?)`,[req.userId,`Added: ${firstName} ${lastName||''}`]);
  save();
  res.json({id:ins[0].values[0][0],firstName,lastName:lastName||'',initials:ini,status:status||'nurture'});
});

// Bulk import endpoint
app.post('/api/contacts/bulk', auth, (req, res) => {
  const {contacts} = req.body;
  if (!contacts||!contacts.length) return res.status(400).json({error:'No contacts provided'});
  const db = getDB();
  let added = 0;
  contacts.forEach(c => {
    if (!c.firstName) return;
    const ini = ((c.firstName[0]||'')+(c.lastName?.[0]||'')).toUpperCase();
    try {
      db.run(`INSERT INTO contacts (user_id,first_name,last_name,initials,phone,email,relationship,contact_type,source,status,notes,tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.userId,c.firstName,c.lastName||'',ini,c.phone||'',c.email||'',c.relationship||'Imported',c.contactType||'unknown',c.source||'import','nurture',c.notes||'','[]']);
      added++;
    } catch(e) {}
  });
  if (added > 0) {
    db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'contact',?)`,[req.userId,`Imported ${added} contacts`]);
  }
  save();
  res.json({added});
});

app.patch('/api/contacts/:id', auth, (req, res) => {
  const db = getDB();
  const allowed = {status:1,notes:1,phone:1,email:1,relationship:1,lastContact:'last_contact',contactType:'contact_type',tags:1};
  for (const [k,v] of Object.entries(req.body)) {
    const col = typeof allowed[k]==='string'?allowed[k]:(k.replace(/([A-Z])/g,'_$1').toLowerCase());
    if (allowed[k]) {
      const val = k==='tags'?JSON.stringify(v):v;
      db.run(`UPDATE contacts SET ${col}=? WHERE id=? AND user_id=?`,[val,req.params.id,req.userId]);
    }
  }
  save(); res.json({ok:true});
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  const db = getDB();
  db.run(`DELETE FROM contacts WHERE id=? AND user_id=?`,[req.params.id,req.userId]);
  db.run(`DELETE FROM contact_activities WHERE contact_id=? AND user_id=?`,[req.params.id,req.userId]);
  save(); res.json({ok:true});
});

// === CONTACT ACTIVITIES (CRM) ===
app.get('/api/contacts/:id/activities', auth, (req, res) => {
  const db = getDB();
  const r = db.exec(`SELECT id,type,notes,outcome,created_at FROM contact_activities WHERE contact_id=${req.params.id} AND user_id='${req.userId}' ORDER BY created_at DESC LIMIT 50`);
  if (!r.length) return res.json([]);
  res.json(r[0].values.map(row => ({id:row[0],type:row[1],notes:row[2],outcome:row[3],createdAt:row[4]})));
});

app.post('/api/contacts/:id/activities', auth, (req, res) => {
  const {type,notes,outcome} = req.body;
  if (!type) return res.status(400).json({error:'Activity type required'});
  const db = getDB();
  db.run(`INSERT INTO contact_activities (user_id,contact_id,type,notes,outcome) VALUES (?,?,?,?,?)`,[req.userId,req.params.id,type,notes||'',outcome||'']);
  // Update last_contact on the contact
  db.run(`UPDATE contacts SET last_contact=datetime('now') WHERE id=? AND user_id=?`,[req.params.id,req.userId]);
  db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'crm',?)`,[req.userId,`${type} logged for contact #${req.params.id}`]);
  save();
  const ins = db.exec(`SELECT last_insert_rowid()`);
  res.json({id:ins[0].values[0][0]});
});

// === CONTENT ===
app.get('/api/content', auth, (req, res) => {
  const db = getDB();
  const r = db.exec(`SELECT id,title,type,status,channels,town,preview,publish_date FROM content WHERE user_id='${req.userId}' ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'generating' THEN 1 WHEN 'draft' THEN 2 WHEN 'scheduled' THEN 3 ELSE 4 END`);
  if (!r.length) return res.json([]);
  res.json(r[0].values.map(row => {
    const o = {}; r[0].columns.forEach((c,i)=>{const k=c.replace(/_([a-z])/g,(_,l)=>l.toUpperCase());o[k]=(c==='channels'?JSON.parse(row[i]||'[]'):row[i]);}); return o;
  }));
});

app.patch('/api/content/:id', auth, (req, res) => {
  const db = getDB();
  const {status,title} = req.body;
  if (status==='published') {
    db.run(`UPDATE content SET status='published',publish_date=datetime('now') WHERE id=? AND user_id=?`,[req.params.id,req.userId]);
    const p = db.exec(`SELECT title FROM content WHERE id=${req.params.id}`);
    db.run(`INSERT INTO activity (user_id,type,text) VALUES (?,'content',?)`,[req.userId,`Published: ${p.length?p[0].values[0][0]:'content'}`]);
  } else if (status) db.run(`UPDATE content SET status=? WHERE id=? AND user_id=?`,[status,req.params.id,req.userId]);
  if (title) db.run(`UPDATE content SET title=? WHERE id=? AND user_id=?`,[title,req.params.id,req.userId]);
  save(); res.json({ok:true});
});

app.post('/api/content', auth, (req, res) => {
  const {title,type,channels,town,preview} = req.body;
  const db = getDB();
  db.run(`INSERT INTO content (user_id,title,type,status,channels,town,preview) VALUES (?,?,?,'draft',?,?,?)`,
    [req.userId,title||'Untitled',type||'social-post',JSON.stringify(channels||[]),town||null,preview||'']);
  save();
  res.json({id:db.exec(`SELECT last_insert_rowid()`)[0].values[0][0]});
});

// === TASKS ===
app.get('/api/tasks/completed', auth, (req, res) => {
  const db = getDB();
  const {week,day} = req.query;
  let sql = `SELECT task_key FROM tasks_completed WHERE user_id='${req.userId}'`;
  if (week) sql += ` AND week=${week}`;
  if (day) sql += ` AND day=${day}`;
  const r = db.exec(sql);
  if (!r.length) return res.json([]);
  res.json(r[0].values.map(x=>x[0]));
});

app.post('/api/tasks/complete', auth, (req, res) => {
  const {week,day,taskKey} = req.body;
  try { getDB().run(`INSERT OR IGNORE INTO tasks_completed (user_id,week,day,task_key) VALUES (?,?,?,?)`,[req.userId,week,day,taskKey]); save(); } catch(e) {}
  res.json({ok:true});
});

app.post('/api/tasks/uncomplete', auth, (req, res) => {
  const {week,day,taskKey} = req.body;
  getDB().run(`DELETE FROM tasks_completed WHERE user_id=? AND week=? AND day=? AND task_key=?`,[req.userId,week,day,taskKey]);
  save(); res.json({ok:true});
});

// === ACTIVITY ===
app.get('/api/activity', auth, (req, res) => {
  const r = getDB().exec(`SELECT id,type,text,created_at FROM activity WHERE user_id='${req.userId}' ORDER BY created_at DESC LIMIT 30`);
  if (!r.length) return res.json([]);
  res.json(r[0].values.map(x=>({id:x[0],type:x[1],text:x[2],createdAt:x[3]})));
});

// === PIPELINE ===
app.get('/api/pipeline', auth, (req, res) => {
  const db = getDB();
  const counts = db.exec(`SELECT status,COUNT(*) FROM contacts WHERE user_id='${req.userId}' GROUP BY status`);
  const stats = {hot:0,warm:0,nurture:0,total:0};
  if (counts.length) counts[0].values.forEach(r=>{stats[r[0]]=r[1];stats.total+=r[1]});
  const pub = db.exec(`SELECT COUNT(*) FROM content WHERE user_id='${req.userId}' AND status='published'`);
  stats.contentPublished = pub.length?pub[0].values[0][0]:0;
  const tc = db.exec(`SELECT COUNT(*) FROM tasks_completed WHERE user_id='${req.userId}'`);
  stats.tasksCompleted = tc.length?tc[0].values[0][0]:0;
  const acts = db.exec(`SELECT COUNT(*) FROM contact_activities WHERE user_id='${req.userId}'`);
  stats.totalActivities = acts.length?acts[0].values[0][0]:0;
  res.json(stats);
});

// === COACHING (static) ===
app.get('/api/coaching', (req, res) => {
  res.json({
    scripts:[
      {title:'Sphere call script',context:'Friends, family, acquaintances',steps:[{label:'Open casually',text:'"Hey! How\'s everything going?"'},{label:'Mention real estate',text:'"I just started in real estate — working the [your area]."'},{label:'Ask the question',text:'"Know anyone thinking about buying or selling?"'},{label:'If no',text:'Thank them. They\'ll remember.'},{label:'If yes',text:'"Would you be comfortable making an intro?"'}]},
      {title:'Home value question',context:'Most common seller question',steps:[{label:'Pull up data',text:'Show real numbers on your phone.'},{label:'Give a range',text:'"Homes like yours are selling between $X-$Y."'},{label:'Next step',text:'"Free comp analysis — takes a day."'}]},
      {title:'Open house script',context:'Engaging walk-ins',steps:[{label:'Welcome',text:'"Hi! Familiar with this neighborhood?"'},{label:'Qualify',text:'"Looking here? Timeline?"'},{label:'Capture',text:'"Best number to text listings?"'}]}
    ],
    objections:[
      {q:'"Wait for rates."',a:'Every dip brings more buyers. Buy now, refinance later.'},
      {q:'"Why a new agent?"',a:'Full attention. Real-time data. Same tools. Hungry.'},
      {q:'"Neighbor got more."',a:'Let me pull that sale. Lot, condition, timing explain it.'},
      {q:'"Zillow says $X."',a:'Zillow misses your updates and recent sales. Free comp analysis.'},
      {q:'"No exclusive."',a:'Lets me invest real time. Protects both of us.'}
    ],
    drafts:{
      sphere_initial:"Hey {name}! I just got my license — working [your area]. If you hear of anyone buying or selling, I'd love the intro!",
      sphere_followup:"Hey {name}, tried to call — nothing urgent! Catching up.",
      market_response:"Great question! [Area] is tight — homes selling fast, above asking. Want listings?",
      warm_intro:"Hey {name}, you mentioned {referral} might be {action}. Comfortable making an intro?",
      open_house_followup:"Hi {name} — great meeting you at {address}! You might like {suggestion}.",
      social_dm:"Hey {name}! Know anyone in [area] buying or selling?",
      check_in:"Hey {name}! New listings in {area} — want them?",
      newsletter:"Hey {name}! Biweekly market updates — real data. Want in?"
    }
  });
});

// Debug
app.get('/debug', (req, res) => {
  const fs = require('fs');
  const dir = path.join(__dirname, 'public');
  try { res.json({cwd:process.cwd(),dirname:__dirname,publicDir:dir,files:fs.readdirSync(dir)}); }
  catch(e) { res.json({cwd:process.cwd(),dirname:__dirname,publicDir:dir,error:e.message}); }
});

// Start
async function start() {
  await initDB();
  const PORT = process.env.PORT||3000;
  app.listen(PORT,'0.0.0.0',()=>{console.log(`Groundwork server running on port ${PORT}`);console.log(`Open: http://localhost:${PORT}`)});
}
start();
