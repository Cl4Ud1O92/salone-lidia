const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { saveTokenFromCode, createEvent } = require('./googleCalendar');

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./lidia.db');

// =======================
//   TABELLE DB
// =======================
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'client',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    service TEXT,
    date TEXT,      -- YYYY-MM-DD
    time TEXT,      -- HH:MM
    note TEXT,
    status TEXT DEFAULT 'pending', -- pending | confirmed | rejected
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Admin di default
  const adminPass = bcrypt.hashSync('admin123', 10);
  db.run(
    `INSERT OR IGNORE INTO users (username, password, role) 
     VALUES ('lidia', ?, 'admin')`,
    [adminPass]
  );
});

// =======================
//   AUTENTICAZIONE
// =======================

// LOGIN
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Credenziali errate' });
    }
    
    const token = jwt.sign(
      { id: user.id, role: user.role, username: user.username },
      'lidia-secret-key'
    );
    res.json({ token, role: user.role, username: user.username });
  });
});

// TEST PROTETTO
app.get('/api/test', (req, res) => {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).json({ error: 'No token' });
  
  jwt.verify(auth, 'lidia-secret-key', (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Token invalido' });
    res.json({ message: `Benvenuto ${decoded.username || 'cliente'}` });
  });
});

// =======================
//   MIDDLEWARE ADMIN
// =======================
app.use('/api/admin', (req, res, next) => {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).json({ error: 'No token' });
  jwt.verify(auth, 'lidia-secret-key', (err, decoded) => {
    if (err || decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin required' });
    }
    req.user = decoded;
    next();
  });
});

// =======================
//   CLIENTI (ADMIN)
// =======================

// Lista clienti
app.get('/api/admin/clients', (req, res) => {
  db.all(
    'SELECT id, username, role, created_at FROM users ORDER BY created_at DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Aggiunta cliente
app.post('/api/add-client', (req, res) => {
  const { username, password } = req.body;
  const hashed = bcrypt.hashSync(password, 10);
  db.run(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
    [username, hashed, 'client'],
    function (err) {
      if (err) return res.status(400).json({ error: err.message });
      res.json({ id: this.lastID, message: 'Cliente aggiunto' });
    }
  );
});

// SLOT DISPONIBILI PER UNA DATA
app.get('/api/appointments/slots', (req, res) => {
  const date = req.query.date; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'Missing date' });

  const day = new Date(date).getDay(); // 0=Dom,1=Lun,...,6=Sab
  // Lavoriamo solo mar–sab (2–6)
  if (day < 2 || day > 6) {
    return res.json([]); // nessuno slot in giorni chiusi
  }

  // Genera slot da 08:30–13:00 e 15:00–19:00 ogni 30 min
  function generateSlots(startHour, startMin, endHour, endMin) {
    const slots = [];
    let h = startHour;
    let m = startMin;
    while (h < endHour || (h === endHour && m < endMin)) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      slots.push(`${hh}:${mm}`);
      m += 30;
      if (m >= 60) {
        m -= 60;
        h += 1;
      }
    }
    return slots;
  }

  const morning = generateSlots(8, 30, 13, 0);
  const afternoon = generateSlots(15, 0, 19, 0);
  const allSlots = [...morning, ...afternoon];

  // Leggi appuntamenti del giorno (pending + confirmed)
  db.all(
    `SELECT time FROM appointments 
     WHERE date = ? AND status IN ('pending','confirmed')`,
    [date],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const busyTimes = rows.map(r => r.time);
      const result = allSlots.map(t => ({
        time: t,
        status: busyTimes.includes(t) ? 'busy' : 'free'
      }));

      res.json(result);
    }
  );
});

// =======================
//   PRENOTAZIONI
// =======================

// 1) Cliente invia richiesta appuntamento (solo DB, status = pending)
app.post('/api/appointments/request', (req, res) => {
  const { service, date, time, note, clientName } = req.body;

  if (!service || !date || !time || !clientName) {
    return res.status(400).json({ success: false, error: 'Dati mancanti' });
  }

  db.get('SELECT id FROM users WHERE username = ?', [clientName], (err, user) => {
    if (err || !user) {
      return res.status(400).json({ success: false, error: 'Utente non trovato' });
    }

    db.run(
      `INSERT INTO appointments (user_id, service, date, time, note, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [user.id, service, date, time, note],
      function (err2) {
        if (err2) {
          return res.status(500).json({ success: false, error: err2.message });
        }
        res.json({ success: true, appointmentId: this.lastID });
      }
    );
  });
});

// 2) Admin: lista appuntamenti
app.get('/api/admin/appointments', (req, res) => {
  db.all(
    `SELECT a.id, u.username, a.service, a.date, a.time, a.note, a.status
     FROM appointments a
     JOIN users u ON a.user_id = u.id
     ORDER BY a.date, a.time`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// 3) Admin: conferma appuntamento → Google Calendar + status=confirmed
app.post('/api/admin/appointments/:id/confirm', (req, res) => {
  const id = req.params.id;

  db.get(
    `SELECT a.*, u.username 
     FROM appointments a
     JOIN users u ON a.user_id = u.id
     WHERE a.id = ?`,
    [id],
    (err, a) => {
      if (err || !a) return res.status(404).json({ error: 'Appuntamento non trovato' });

      const startDateTime = new Date(`${a.date}T${a.time}:00`);
      const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

      const event = {
        summary: `Appuntamento: ${a.service} - ${a.username}`,
        description: a.note || '',
        start: { dateTime: startDateTime.toISOString(), timeZone: 'Europe/Rome' },
        end:   { dateTime: endDateTime.toISOString(),   timeZone: 'Europe/Rome' }
      };

      createEvent(event)
        .then((ev) => {
          db.run(
            'UPDATE appointments SET status = ? WHERE id = ?',
            ['confirmed', id],
            (err2) => {
              if (err2) return res.status(500).json({ error: err2.message });
              res.json({ success: true, eventId: ev.id });
            }
          );
        })
        .catch((e2) => {
          console.error('Errore Google Calendar:', e2);
          res.status(500).json({ error: 'Errore Google Calendar' });
        });
    }
  );
});

// 4) Admin: rifiuta appuntamento
app.post('/api/admin/appointments/:id/reject', (req, res) => {
  const id = req.params.id;
  db.run(
    'UPDATE appointments SET status = ? WHERE id = ?',
    ['rejected', id],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// 5) Cliente: tutti i suoi appuntamenti (per username)
app.get('/api/appointments/my', (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Missing username' });
  }

  db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Utente non trovato' });
    }

    db.all(
      `SELECT id, service, date, time, note, status, created_at
       FROM appointments
       WHERE user_id = ?
       ORDER BY date ASC, time ASC`,
      [user.id],
      (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json(rows);
      }
    );
  });
});

// =======================
//   OAUTH GOOGLE
// =======================
app.get('/oauth2callback', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');
  saveTokenFromCode(code, res);
});

// =======================
//   AVVIO SERVER
// =======================
app.listen(3000, () => console.log('🚀 Server Lidia: http://localhost:3000'));
