// index.js 本地开发用
const app = require('./server');

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Local dev server running at http://localhost:${port}`);
});
