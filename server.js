// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const geoCache = new Map();
const app = express();
const port = process.env.PORT || 3000;

const PLAYER_MAX_VOTES = 3;
const PLAYER_WINDOW_MINUTES = 5;

const IP_MAX_VOTES = 200;
const IP_WINDOW_MINUTES = 10;


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_KEY;

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // <--- add this
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


function requireAdminBasic(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    return res
      .status(500)
      .send('ADMIN_USER or ADMIN_PASSWORD is not configured on the server.');
  }

  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }

  const base64Credentials = authHeader.split(' ')[1];
  const decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');

  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(401).send('Invalid credentials.');
}



// If running behind Render/Heroku proxy, trust it so req.ip / x-forwarded-for works nicely
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Helpers ---------- //

// Return votes that are considered "active" based on constraints.
async function getActiveVotes() {
  // Fetch all votes
  // We'll filter with SQL using includes/excludes constraints.
  const query = `
    WITH includes AS (
      SELECT start_time, end_time
      FROM vote_constraints
      WHERE enabled = true AND type = 'include'
    ),
    excludes AS (
      SELECT start_time, end_time
      FROM vote_constraints
      WHERE enabled = true AND type = 'exclude'
    )
    SELECT v.id, v.value
    FROM votes v
    WHERE
      (
        -- If there are no "include" constraints, all times are allowed
        NOT EXISTS (SELECT 1 FROM includes)
        OR EXISTS (
          SELECT 1 FROM includes i
          WHERE v.created_at BETWEEN i.start_time AND i.end_time
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM excludes e
        WHERE v.created_at BETWEEN e.start_time AND e.end_time
      );
  `;

  const { rows } = await pool.query(query);
  return rows; // [{id, value}, ...]
}



async function computeGameStats(newVoteId) {
  const rows = await getActiveVotes();

  if (rows.length === 0) {
    return {
      average: null,
      target: null,
      isWinner: false,
      totalVotes: 0,
    };
  }

  const values = rows.map((r) => r.value);
  const totalVotes = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const average = sum / totalVotes;
  const target = average / 2;

  let minDist = Infinity;
  const distances = rows.map((row) => {
    const dist = Math.abs(row.value - target);
    if (dist < minDist) minDist = dist;
    return { id: row.id, value: row.value, dist };
  });

  const winners = distances.filter((d) => d.dist === minDist).map((d) => d.id);
  const isWinner = winners.includes(newVoteId);

  return {
    average,
    target,
    isWinner,
    totalVotes,
  };
}


// Extract client IP (handles x-forwarded-for & IPv6 prefix)
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  const ip = req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

// Geolocate IP via ipapi.co
async function getLocationFromIp(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  if (
    !ip ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.')
  ) {
    return 'Local network';
  }

  try {
    const res = await fetch(`https://ipwho.is/${ip}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    if (data.success === false) {
      console.error('ipwho.is failed for', ip, data.message);
      return 'Unknown location';
    }

    const city = data.city || '';
    const region = data.region || '';
    const country = data.country || '';

    const parts = [city, region, country].filter(Boolean);
    if (parts.length === 0) return 'Unknown location';
    geoCache.set(ip, parts.join(', '));
    return parts.join(', ');
  } catch (err) {
    console.error('Error geolocating IP:', ip, err.message);
    return 'Unknown location';
  }
}
// Verify Google reCAPTCHA v2 token
async function verifyRecaptcha(token, remoteIp) {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) {
    console.error('Missing RECAPTCHA_SECRET env var');
    return false;
  }

  if (!token) {
    return false;
  }

  const params = new URLSearchParams();
  params.append('secret', secret);
  params.append('response', token);
  if (remoteIp) {
    params.append('remoteip', remoteIp);
  }

  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Error verifying reCAPTCHA:', err.message);
    return false;
  }
}

function getOrCreatePlayerId(req, res) {
  let playerId = req.body.player_id || req.cookies.player_id;
  if (!playerId) {
    // Node 18+ has crypto.randomUUID()
    playerId = crypto.randomUUID();
    // Set cookie (HTTP-only so JS can't read it)
    res.cookie('player_id', playerId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true, // for HTTPS on Vercel
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    });
  }
  return playerId;
}


// ---------- Routes ---------- //

// GET / – first load: no result, no activity board yet
app.get('/', async (req, res) => {
  res.render('index', {
    result: null,
    recentVotes: null,
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  });
});

app.post('/vote', async (req, res) => {
  try {
    const raw = req.body.value;
    const num = parseInt(raw, 10);

    if (Number.isNaN(num) || num < 0 || num > 1000) {
      return res.render('index', {
        result: {
          error: 'Please submit an integer between 0 and 1000.',
        },
        recentVotes: null,
      });
    }

    const ip = getClientIp(req);
    const playerId = getOrCreatePlayerId(req, res);

    // ---- 1) Per-player rate limit (main protection) ----
    const playerCheck = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM votes
       WHERE player_id = $1
         AND created_at >= NOW() - INTERVAL '${PLAYER_WINDOW_MINUTES} minutes'`,
      [playerId]
    );
    const playerCnt = parseInt(playerCheck.rows[0].cnt, 10);

    if (playerCnt >= PLAYER_MAX_VOTES) {
      return res.render('index', {
        result: {
          error: `You have voted too many times recently. Please wait ${PLAYER_WINDOW_MINUTES} minutes.`,
        },
        recentVotes: null,
      });
    }

    // ---- 2) Per-IP hard cap (just in case someone scripts many browsers behind one IP) ----
    const ipCheck = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM votes
       WHERE ip_address = $1
         AND created_at >= NOW() - INTERVAL '${IP_WINDOW_MINUTES} minutes'`,
      [ip]
    );
    const ipCnt = parseInt(ipCheck.rows[0].cnt, 10);

    if (ipCnt >= IP_MAX_VOTES) {
      return res.render('index', {
        result: {
          error: `Too many votes from your network. Please wait a bit and try again.`,
        },
        recentVotes: null,
      });
    }

    // ---- 3) Get location + insert vote as before ----
    const location = await getLocationFromIp(ip);

    const insertRes = await pool.query(
      'INSERT INTO votes(value, ip_address, location, player_id) VALUES($1, $2, $3, $4) RETURNING id',
      [num, ip, location, playerId]
    );
    const newVoteId = insertRes.rows[0].id;

    const stats = await computeGameStats(newVoteId);

    const recentRes = await pool.query(
      'SELECT value, location, created_at FROM votes ORDER BY created_at DESC LIMIT 10'
    );
    const recentVotes = recentRes.rows;

    res.render('index', {
      result: {
        userValue: num,
        average: stats.average,
        target: stats.target,
        isWinner: stats.isWinner,
        totalVotes: stats.totalVotes,
        error: null,
      },
      recentVotes,
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      result: {
        error: 'Something went wrong. Please try again later.',
      },
      recentVotes: null,
    });
  }
});


// app.listen(port, () => {
  // console.log(`Server running on http://localhost:${port}`);
// });

module.exports = app;





// ---------- Admin routes ---------- //


// GET /admin – dashboard: constraints + recent votes
app.get('/admin', requireAdminBasic, async (req, res) => {
  try {
    const constraintsRes = await pool.query(
      'SELECT id, start_time, end_time, type, enabled, note, created_at FROM vote_constraints ORDER BY created_at DESC'
    );
    const constraints = constraintsRes.rows;

    const votesRes = await pool.query(
      'SELECT id, value, location, created_at FROM votes ORDER BY created_at DESC LIMIT 50'
    );
    const votes = votesRes.rows;

    res.render('admin', {
      constraints,
      votes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading admin page.');
  }
});

// POST /admin/constraints – create a new time constraint
app.post('/admin/constraints', requireAdminBasic, async (req, res) => {
  try {
    const { start, end, type, enabled, note } = req.body;

    if (!start || !end || !type) {
      return res.status(400).send('Missing start, end, or type.');
    }

    const startTime = new Date(start);
    const endTime = new Date(end);

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).send('Invalid date format.');
    }

    if (!['include', 'exclude'].includes(type)) {
      return res.status(400).send('Invalid constraint type.');
    }

    const isEnabled = enabled === 'on';

    await pool.query(
      `INSERT INTO vote_constraints (start_time, end_time, type, enabled, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [startTime.toISOString(), endTime.toISOString(), type, isEnabled, note || null]
    );

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating constraint.');
  }
});

// POST /admin/constraints/:id/toggle – enable/disable a constraint
app.post('/admin/constraints/:id/toggle', requireAdminBasic, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).send('Invalid constraint ID.');
    }

    await pool.query(
      'UPDATE vote_constraints SET enabled = NOT enabled WHERE id = $1',
      [id]
    );

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error toggling constraint.');
  }
});

// POST /admin/constraints/:id/delete – delete a constraint
app.post('/admin/constraints/:id/delete', requireAdminBasic, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).send('Invalid constraint ID.');
    }

    await pool.query('DELETE FROM vote_constraints WHERE id = $1', [id]);

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting constraint.');
  }
});

// POST /admin/votes/:id/delete – delete a vote
app.post('/admin/votes/:id/delete', requireAdminBasic, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).send('Invalid vote ID.');
    }

    await pool.query('DELETE FROM votes WHERE id = $1', [id]);

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting vote.');
  }
});
