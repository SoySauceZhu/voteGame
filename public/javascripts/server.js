const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- In-memory storage (replace with DB in production) ----
let submissions = []; // each element: { value: number, timestamp: number }

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Serve the single page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API endpoint for submissions
app.post("/api/submit", (req, res) => {
  let { value } = req.body;

  // Basic validation
  value = Number(value);
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    return res
      .status(400)
      .json({ error: "Value must be an integer between 0 and 1000." });
  }

  const submission = { value, timestamp: Date.now() };
  submissions.push(submission);

  const n = submissions.length;
  const average =
    submissions.reduce((sum, s) => sum + s.value, 0) / (n || 1);
  const target = average / 2;

  // Find current winner (closest to target)
  let bestIndex = 0;
  let bestDiff = Math.abs(submissions[0].value - target);

  for (let i = 1; i < submissions.length; i++) {
    const diff = Math.abs(submissions[i].value - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = i;
    }
  }

  const winningSubmission = submissions[bestIndex];
  const isCurrentWinner = winningSubmission === submission;

  res.json({
    submissionsCount: n,
    average,
    target,
    yourValue: value,
    winningValue: winningSubmission.value,
    isCurrentWinner
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
