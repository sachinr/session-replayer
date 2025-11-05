const express = require("express");
const path = require("path");
const dotenv = require("dotenv").config();
const fs = require("fs");
const app = express();
const port = 3000;

// Route for the main page - must be BEFORE static middleware
app.get("/", (req, res) => {
  // Disable caching to ensure fresh content on every request
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  const posthogApiKey = process.env.POSTHOG_API_KEY || "";
  if (!posthogApiKey) {
    console.warn(
      "⚠️  Warning: POSTHOG_API_KEY environment variable is not set"
    );
  }
  console.log(
    "PostHog API Key:",
    posthogApiKey ? "***" + posthogApiKey.slice(-4) : "NOT SET"
  );

  // Read file fresh on every request
  const htmlContent = fs.readFileSync(
    path.join(__dirname, "index.html"),
    "utf8"
  );
  const processedHtml = htmlContent.replace(
    "${process.env.POSTHOG_API_KEY}",
    posthogApiKey
  );
  res.send(processedHtml);
});

// Serve static files (but exclude index.html since we handle it above)
app.use(
  express.static(".", {
    index: false, // Don't serve index.html automatically
  })
);

app.listen(port, () => {
  console.log(`Demo app running at http://localhost:${port}`);
  console.log("Make sure to run the proxy server on port 3001");
});
