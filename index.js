// index.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Postgres connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middlewares
app.use(express.urlencoded({ extended: true })); // handle form submissions
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper: compute game stats
async function computeGameStats(newVoteId) {
  // Get all votes
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

  // Find minimal distance
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

// GET / – show page (no result yet)
app.get('/', async (req, res) => {
  res.render('index', {
    result: null, // no result at first load
  });
});

// POST /vote – handle submission
app.post('/vote', async (req, res) => {
  try {
    const raw = req.body.value;
    const num = parseInt(raw, 10);

    if (Number.isNaN(num) || num < 0 || num > 1000) {
      return res.render('index', {
        result: {
          error: 'Please submit an integer between 0 and 1000.',
        },
      });
    }

    // Insert vote
    const insertRes = await pool.query(
      'INSERT INTO votes(value) VALUES($1) RETURNING id',
      [num]
    );
    const newVoteId = insertRes.rows[0].id;

    // Compute game stats
    const stats = await computeGameStats(newVoteId);

    res.render('index', {
      result: {
        userValue: num,
        average: stats.average,
        target: stats.target,
        isWinner: stats.isWinner,
        totalVotes: stats.totalVotes,
        error: null,
      },
    });
  } catch (err) {
    console.error(err);
    res.render('index', {
      result: {
        error: 'Something went wrong. Please try again later.',
      },
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
