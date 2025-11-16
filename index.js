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

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- NEW: helper to get client IP (behind proxy like Render) ---
function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) {
    // "client, proxy1, proxy2"
    return xfwd.split(',')[0].trim();
  }
  // Fallback
  return req.ip || req.connection.remoteAddress;
}

// --- NEW: lookup location from IP using a free API ---
async function lookupLocation(ip) {
  try {
    if (!ip) return 'Unknown location';

    // local dev
    if (ip === '127.0.0.1' || ip === '::1') {
      return 'Localhost';
    }

    // ip-api.com: free, no key, HTTP only (fine for server-side)
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city`
    );
    const data = await res.json();
    if (data.status === 'success') {
      return [data.city, data.regionName, data.country].filter(Boolean).join(', ');
    }
    return 'Unknown location';
  } catch (err) {
    console.error('IP lookup failed:', err);
    return 'Unknown location';
  }
}

// --- NEW: get latest 10 votes for activity board ---
async function getRecentVotes() {
  const { rows } = await pool.query(
    `SELECT value, location, created_at
     FROM votes
     ORDER BY created_at DESC
     LIMIT 10`
  );
  return rows;
}

// Existing: compute stats
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

// GET / – show page (with recent activity, no result yet)
app.get('/', async (req, res) => {
  const recentVotes = await getRecentVotes(); // NEW
  res.render('index', {
    result: null,
    recentVotes,
  });
});

// POST /vote – handle submission
app.post('/vote', async (req, res) => {
  try {
    const raw = req.body.value;
    const num = parseInt(raw, 10);

    if (Number.isNaN(num) || num < 0 || num > 1000) {
      const recentVotes = await getRecentVotes(); // NEW
      return res.render('index', {
        result: {
          error: 'Please submit an integer between 0 and 1000.',
        },
        recentVotes,
      });
    }

    // NEW: IP + location
    const ip = getClientIp(req);
    const location = await lookupLocation(ip);

    // Insert vote with IP + location
    const insertRes = await pool.query(
      'INSERT INTO votes(value, ip_address, location) VALUES($1, $2, $3) RETURNING id',
      [num, ip, location]
    );
    const newVoteId = insertRes.rows[0].id;

    // Compute game stats
    const stats = await computeGameStats(newVoteId);

    // Get recent activity
    const recentVotes = await getRecentVotes(); // NEW

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
    const recentVotes = await getRecentVotes(); // NEW
    res.render('index', {
      result: {
        error: 'Something went wrong. Please try again later.',
      },
      recentVotes,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
