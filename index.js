// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});


const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_KEY;

function requireAdmin(req, res, next) {
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

// Compute game stats & whether newVoteId is currently a winner
async function computeGameStats(newVoteId) {
  const { rows } = await pool.query(
    'SELECT id, value FROM votes WHERE is_active = true'
  );
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
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const city = data.city || '';
    const region = data.region || '';
    const country = data.country_name || '';

    const parts = [city, region, country].filter(Boolean);
    if (parts.length === 0) return 'Unknown location';
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

// ---------- Routes ---------- //

// GET / – first load: no result, no activity board yet
app.get('/', async (req, res) => {
  res.render('index', {
    result: null,
    recentVotes: null,
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  });
});

// POST /vote – handle submission, verify CAPTCHA, then process vote
app.post('/vote', async (req, res) => {
  try {
    const raw = req.body.value;
    const num = parseInt(raw, 10);

    const captchaToken = req.body['g-recaptcha-response'];
    const ip = getClientIp(req);

    // // 1) Verify CAPTCHA
    // const captchaOk = await verifyRecaptcha(captchaToken, ip);
    // if (!captchaOk) {
    //   return res.render('index', {
    //     result: {
    //       error: 'CAPTCHA verification failed. Please confirm you are not a robot and try again.',
    //     },
    //     recentVotes: null,
    //     recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    //   });
    // }

    // 2) Validate number
    if (Number.isNaN(num) || num < 0 || num > 1000) {
      return res.render('index', {
        result: {
          error: 'Please submit an integer between 0 and 1000.',
        },
        recentVotes: null,
        recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
      });
    }

    // 3) Geolocate IP
    const location = await getLocationFromIp(ip);

    // 4) Insert vote
    const insertRes = await pool.query(
      'INSERT INTO votes(value, ip_address, location) VALUES($1, $2, $3) RETURNING id',
      [num, ip, location]
    );
    const newVoteId = insertRes.rows[0].id;

    // 5) Compute stats
    const stats = await computeGameStats(newVoteId);

    // 6) Latest 10 votes (activity board)
    const recentRes = await pool.query(
      'SELECT value, location, created_at FROM votes WHERE is_active = true ORDER BY created_at DESC LIMIT 10'
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
      recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      result: {
        error: 'Something went wrong. Please try again later.',
      },
      recentVotes: null,
      recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});





// ---------- Admin routes ---------- //

// GET /admin – admin dashboard
app.get('/admin', requireAdmin, async (req, res) => {
  try {
    // Show latest 50 votes (including inactive) so admin can manage them
    const result = await pool.query(
      'SELECT id, value, location, created_at, is_active FROM votes ORDER BY created_at DESC LIMIT 50'
    );
    const votes = result.rows;

    res.render('admin', {
      votes,
      adminKey: req.query.key, // to keep key in form actions
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading admin page.');
  }
});

// POST /admin/range – enable/disable votes in a time range
app.post('/admin/range', requireAdmin, async (req, res) => {
  try {
    const { start, end, action } = req.body;
    const adminKey = req.query.key;

    if (!start || !end || !action) {
      return res.status(400).send('Missing start, end, or action.');
    }

    // Expecting ISO-like strings from datetime-local input
    const startTime = new Date(start);
    const endTime = new Date(end);

    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).send('Invalid date format.');
    }

    const enable = action === 'enable';

    await pool.query(
      'UPDATE votes SET is_active = $1 WHERE created_at BETWEEN $2 AND $3',
      [enable, startTime.toISOString(), endTime.toISOString()]
    );

    // redirect back to admin page, preserving admin key
    res.redirect(`/admin?key=${encodeURIComponent(adminKey)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating votes by time range.');
  }
});

// POST /admin/delete/:id – hard delete a vote
app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const adminKey = req.query.key;

    if (Number.isNaN(id)) {
      return res.status(400).send('Invalid vote ID.');
    }

    await pool.query('DELETE FROM votes WHERE id = $1', [id]);

    res.redirect(`/admin?key=${encodeURIComponent(adminKey)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting vote.');
  }
});
