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

// Helper: get latest 10 votes for activity board
async function getRecentVotes(limit = 10) {
  const { rows } = await pool.query(
    'SELECT value, location, created_at FROM votes ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

// GET / – show page (no result yet, but show recent activity)
app.get('/', async (req, res) => {
  try {
    const recentVotes = await getRecentVotes();
    res.render('index', {
      result: null,
      recentVotes,
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      result: { error: 'Failed to load recent activity.' },
      recentVotes: [],
    });
  }
});

// POST /vote – handle submission
app.post('/vote', async (req, res) => {
  try {
    const raw = req.body.value;
    const num = parseInt(raw, 10);
    const location = (req.body.location || '').trim(); // NEW

    if (Number.isNaN(num) || num < 0 || num > 1000) {
      const recentVotes = await getRecentVotes();
      return res.render('index', {
        result: {
          error: 'Please submit an integer between 0 and 1000.',
        },
        recentVotes,
      });
    }

    // Insert vote with location
    const insertRes = await pool.query(
      'INSERT INTO votes(value, location) VALUES($1, $2) RETURNING id',
      [num, location || null]
    );
    const newVoteId = insertRes.rows[0].id;

    // Compute stats for the new vote
    const stats = await computeGameStats(newVoteId);

    // Get recent votes for activity board
    const recentVotes = await getRecentVotes();

    res.render('index', {
      result: {
        userValue: num,
        average: stats.average,
        target: stats.target,
        isWinner: stats.isWinner,
        totalVotes: stats.totalVotes,
        error: null,
        userLocation: location,
      },
      recentVotes,
    });
  } catch (err) {
    console.error(err);
    const recentVotes = await getRecentVotes().catch(() => []);
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
