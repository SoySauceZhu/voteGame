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

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper: compute game stats
async function computeGameStats(newVoteId) {
  const { rows } = await pool.query('SELECT id, value FROM votes');
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

// Helper: extract IP address from request (handles reverse proxy / Render)
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  const ip = req.socket?.remoteAddress || '';
  // Remove IPv6 prefix like ::ffff:
  return ip.replace(/^::ffff:/, '');
}

// Helper: get location string from IP using ipapi.co
async function getLocationFromIp(ip) {
  // Local dev / private IPs won't be geolocatable
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
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

// GET / – first load, no result, no activity board
app.get('/', async (req, res) => {
  res.render('index', {
    result: null,
    recentVotes: null, // no board yet
  });
});

// POST /vote – handle submission, show result + latest 10 votes
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
    const location = await getLocationFromIp(ip);

    // Insert vote with IP and location
    const insertRes = await pool.query(
      'INSERT INTO votes(value, ip_address, location) VALUES($1, $2, $3) RETURNING id',
      [num, ip, location]
    );
    const newVoteId = insertRes.rows[0].id;

    // Compute game stats
    const stats = await computeGameStats(newVoteId);

    // Fetch latest 10 votes for activity board
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
