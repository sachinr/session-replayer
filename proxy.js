const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const https = require("https");
const zlib = require("zlib");

const app = express();
const port = 3001;

// Enable CORS for all routes
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

// Custom body parser that preserves compressed data
app.use((req, res, next) => {
  if (req.method === "GET") {
    return next();
  }

  const chunks = [];

  req.on("data", (chunk) => {
    chunks.push(chunk);
  });

  req.on("end", () => {
    const buffer = Buffer.concat(chunks);
    req.rawBody = buffer;

    // Check if data is compressed:
    // 1. Check content-encoding header
    // 2. Check if buffer starts with gzip magic bytes (0x1f 0x8b)
    // 3. Check query param (if URL is parsed)
    const encoding = req.headers["content-encoding"];
    const hasGzipMagic = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const queryCompression = req.query && req.query.compression;
    const isCompressed = encoding || hasGzipMagic || queryCompression;
    
    // Only parse if not compressed
    if (!isCompressed && buffer.length > 0) {
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("application/json")) {
        try {
          req.body = JSON.parse(buffer.toString());
        } catch (e) {
          req.body = {};
        }
      } else {
        req.body = {};
      }
    } else {
      // Keep as buffer for decompression later
      req.body = buffer;
    }

    next();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    next(err);
  });
});

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.access("data");
  } catch {
    await fs.mkdir("data");
  }
}

// Helper function to decompress nested DOM snapshots
async function decompressNestedSnapshots(data) {
  try {
    // If it's an array, process each item
    if (Array.isArray(data)) {
      return await Promise.all(
        data.map((item) => decompressNestedSnapshots(item)),
      );
    }

    // If it's an object, look for specific patterns
    if (data && typeof data === "object") {
      const result = { ...data };

      // Check if this is a PostHog snapshot event with $snapshot_data
      if (
        result.properties &&
        result.properties.$snapshot_data &&
        Array.isArray(result.properties.$snapshot_data)
      ) {
        result.properties.$snapshot_data = await Promise.all(
          result.properties.$snapshot_data.map(async (snapshot) => {
            // Type 2 snapshots contain compressed DOM data
            if (snapshot.type === 2 && typeof snapshot.data === "string") {
              try {
                // Check if data starts with gzip header bytes (31, 139)
                if (
                  snapshot.data.length > 2 &&
                  snapshot.data.charCodeAt(0) === 31 &&
                  snapshot.data.charCodeAt(1) === 139
                ) {
                  // Convert Unicode string back to buffer
                  const buffer = Buffer.from(snapshot.data, "latin1");
                  const decompressed = zlib.gunzipSync(buffer);
                  return {
                    ...snapshot,
                    data: decompressed.toString("utf8"),
                    _original_compressed: true,
                  };
                }
              } catch (err) {
                console.log(
                  `Could not decompress DOM snapshot: ${err.message}`,
                );
                return {
                  ...snapshot,
                  _decompression_error: err.message,
                };
              }
            }
            return snapshot;
          }),
        );
      }

      // Recursively process other nested objects
      for (const [key, value] of Object.entries(result)) {
        if (value && typeof value === "object") {
          result[key] = await decompressNestedSnapshots(value);
        }
      }

      return result;
    }

    return data;
  } catch (error) {
    console.error("Error in decompressNestedSnapshots:", error);
    return data;
  }
}

// Append data to JSONL file
async function appendToJSONL(filename, data) {
  try {
    await ensureDataDir();
    const filepath = path.join("data", filename);
    const jsonLine =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        originalTimestamp: Date.now(),
        ...data,
      }) + "\n";
    await fs.appendFile(filepath, jsonLine);
  } catch (error) {
    console.error("Error saving to JSONL:", error.message);
  }
}

// Manual proxy function
async function proxyRequest(req, res, targetHost, targetPath = req.path) {
  console.log(`\n🔄 ${req.method} ${req.path}`);
  console.log(`🚀 Proxying to: https://${targetHost}${targetPath}`);

  // Handle different content types properly
  let postData = null;
  if (req.method === "POST" && req.rawBody && req.rawBody.length > 0) {
    postData = req.rawBody; // Always use the raw buffer
    const encoding = req.headers["content-encoding"];
    if (encoding) {
      console.log(
        `📤 Sending compressed data (${encoding}): ${req.rawBody.length} bytes`,
      );
    } else {
      console.log(`📤 Sending data: ${req.rawBody.length} bytes`);
    }
  }

  const options = {
    hostname: targetHost,
    port: 443,
    path:
      targetPath + (req.url.includes("?") ? "?" + req.url.split("?")[1] : ""),
    method: req.method,
    headers: {
      Host: targetHost,
      "Content-Type": req.headers["content-type"] || "application/json",
      "User-Agent": req.headers["user-agent"] || "PostHog-Proxy/1.0",
      // Forward compression headers
      ...(req.headers["content-encoding"] && {
        "Content-Encoding": req.headers["content-encoding"],
      }),
      ...(req.headers["accept-encoding"] && {
        "Accept-Encoding": req.headers["accept-encoding"],
      }),
      ...(postData && {
        "Content-Length": postData.length,
      }),
    },
  };

  return new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      console.log(`✅ Response: ${proxyRes.statusCode} from ${targetHost}`);

      // Set response headers (excluding compression headers since we'll handle decompression)
      Object.keys(proxyRes.headers).forEach((key) => {
        if (key !== "content-encoding" && key !== "content-length") {
          res.setHeader(key, proxyRes.headers[key]);
        }
      });
      res.statusCode = proxyRes.statusCode;

      // Handle compression
      const encoding = proxyRes.headers["content-encoding"];
      let responseStream = proxyRes;

      if (encoding === "gzip") {
        responseStream = proxyRes.pipe(zlib.createGunzip());
      } else if (encoding === "deflate") {
        responseStream = proxyRes.pipe(zlib.createInflate());
      } else if (encoding === "br") {
        responseStream = proxyRes.pipe(zlib.createBrotliDecompress());
      }

      // Pipe decompressed response
      responseStream.pipe(res);
      responseStream.on("end", resolve);
      responseStream.on("error", (err) => {
        console.error("Decompression error:", err);
        res.status(500).end();
        resolve();
      });
    });

    proxyReq.on("error", (error) => {
      console.error(`❌ Proxy error:`, error.message);
      res.status(500).json({ error: "Proxy error", message: error.message });
      resolve();
    });

    // 🔍 LOG FULL REQUEST DETAILS FOR COMPARISON
    console.log("\n📤 FULL POSTHOG REQUEST DETAILS:");
    console.log(`   Method: ${options.method}`);
    console.log(`   Host: ${options.hostname}:${options.port}`);
    console.log(`   Path: ${options.path}`);
    console.log(`   Headers:`);
    Object.entries(options.headers).forEach(([key, value]) => {
      console.log(`     ${key}: ${value}`);
    });
    console.log(`   Body Size: ${postData ? postData.length : 0} bytes`);
    if (postData && postData.length < 1000) {
      console.log(`   Body Preview: ${postData.slice(0, 200)}...`);
    }
    console.log("");

    // Send request body if POST
    if (postData) {
      proxyReq.write(postData);
    }
    proxyReq.end();
  });
}

// Handle static assets
app.get("/static/*", async (req, res) => {
  console.log(`📦 Static asset: ${req.path}`);
  await proxyRequest(req, res, "us-assets.i.posthog.com");
});

// Handle /flags endpoint (critical for session recordings)
app.post("/flags/*", async (req, res) => {
  console.log(`🎯 Flags request: ${req.path}`);
  await proxyRequest(req, res, "us.i.posthog.com");
});

// Handle events endpoint
app.post("/e/*", async (req, res) => {
  console.log(`📊 Event: ${req.path}`);

  const encoding = req.headers["content-encoding"];
  const isCompressed = req.query.compression === "gzip-js" || encoding === "gzip" || encoding === "deflate" || encoding === "br";

  // Handle compressed events (PostHog sends events with compression: gzip-js in query)
  // Check this first, before checking req.body
  if (isCompressed && req.rawBody && req.rawBody.length > 0) {
    try {
      let decompressedData = null;
      let originalData = req.rawBody;

      // Handle different compression types
      // PostHog uses compression: gzip-js in query params, not content-encoding header
      if (req.query.compression === "gzip-js" || encoding === "gzip") {
        decompressedData = zlib.gunzipSync(originalData);
      } else if (encoding === "deflate") {
        decompressedData = zlib.inflateSync(originalData);
      } else if (encoding === "br") {
        decompressedData = zlib.brotliDecompressSync(originalData);
      }

      if (decompressedData) {
        const parsedData = JSON.parse(decompressedData.toString());

        // Save decompressed data so we can access session IDs
        await appendToJSONL("events.jsonl", {
          type: "event",
          data: parsedData, // Save decompressed data
          headers: req.headers,
          query: req.query,
        });

        console.log(
          `📊 Event saved: ${originalData.length} bytes compressed -> ${decompressedData.length} bytes decompressed`,
        );
        if (Array.isArray(parsedData)) {
          console.log(`   Found ${parsedData.length} event(s) in batch`);
        } else if (parsedData.properties?.$session_id) {
          console.log(`   Session ID: ${parsedData.properties.$session_id}`);
        }
      } else {
        // Fallback: save compressed data info
        await appendToJSONL("events.jsonl", {
          type: "event",
          data: {
            type: "Buffer",
            data: Array.from(originalData),
          },
          headers: req.headers,
          query: req.query,
        });
        console.log(
          `📊 Event saved as compressed: ${originalData.length} bytes`,
        );
      }
    } catch (error) {
      console.error("Error processing event data:", error);
      // Fallback: save raw body info
      await appendToJSONL("events.jsonl", {
        type: "event",
        data: {
          type: "Buffer",
          data: Array.from(req.rawBody),
        },
        headers: req.headers,
        query: req.query,
      });
    }
  }
  // Handle uncompressed events
  else if (!encoding && req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    console.log(`📊 Event data:`, req.body);
    // Save to JSONL
    await appendToJSONL("events.jsonl", {
      type: "event",
      data: req.body,
      headers: req.headers,
      query: req.query,
    });
  } else {
    console.log(`📊 Event data: ${req.rawBody ? req.rawBody.length : 0} bytes (not saved - empty or unknown format)`);
  }

  await proxyRequest(req, res, "us.i.posthog.com");
});

// Handle session recordings endpoint
app.post("/s/*", async (req, res) => {
  console.log(`🎥 Recording: ${req.path}`);

  const encoding = req.headers["content-encoding"];

  if (
    !encoding &&
    req.body &&
    typeof req.body === "object" &&
    Object.keys(req.body).length > 0
  ) {
    // Uncompressed JSON data - save as is
    await appendToJSONL("recordings.jsonl", {
      type: "recording",
      data: req.body,
      headers: req.headers,
      query: req.query,
    });
  } else if (req.rawBody && req.rawBody.length > 0) {
    // Compressed data - implement dual storage
    try {
      let decompressedData = null;
      let originalData = req.rawBody;

      // Handle different compression types
      if (encoding === "gzip" || req.query.compression === "gzip-js") {
        decompressedData = zlib.gunzipSync(originalData);
      } else if (encoding === "deflate") {
        decompressedData = zlib.inflateSync(originalData);
      } else if (encoding === "br") {
        decompressedData = zlib.brotliDecompressSync(originalData);
      }

      if (decompressedData) {
        const parsedData = JSON.parse(decompressedData.toString());

        // Save dual format: original compressed + decompressed
        await appendToJSONL("recordings.jsonl", {
          type: "recording",
          data: {
            type: "Buffer",
            data: Array.from(originalData), // Keep original format for PostHog compatibility
          },
          decompressed: await decompressNestedSnapshots(parsedData), // Add fully readable format for analysis
          headers: req.headers,
          query: req.query,
        });

        console.log(
          `🎥 Recording saved with dual storage: ${originalData.length} bytes compressed -> ${decompressedData.length} bytes decompressed`,
        );
      } else {
        // Fallback: save as original format
        await appendToJSONL("recordings.jsonl", {
          type: "recording",
          data: {
            type: "Buffer",
            data: Array.from(originalData),
          },
          headers: req.headers,
          query: req.query,
        });
        console.log(
          `🎥 Recording saved as original: ${originalData.length} bytes`,
        );
      }
    } catch (error) {
      console.error("Error processing recording data:", error);
      // Fallback: save as original format
      await appendToJSONL("recordings.jsonl", {
        type: "recording",
        data: {
          type: "Buffer",
          data: Array.from(req.rawBody),
        },
        headers: req.headers,
        query: req.query,
      });
    }
  }

  console.log(
    `🎥 Recording data: ${req.rawBody ? req.rawBody.length : 0} bytes`,
  );
  await proxyRequest(req, res, "us.i.posthog.com");
});

// Handle all other POST requests
app.post("*", async (req, res) => {
  console.log(`🔄 Generic POST: ${req.path}`);
  await proxyRequest(req, res, "us.i.posthog.com");
});

// Handle all GET requests
app.get("*", async (req, res) => {
  if (req.path === "/health") {
    res.json({
      status: "ok",
      proxy: "Working PostHog Proxy",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  console.log(`🔄 Generic GET: ${req.path}`);
  await proxyRequest(req, res, "us.i.posthog.com");
});

app.listen(port, () => {
  console.log(`🚀 Working PostHog Proxy running on http://localhost:${port}`);
  console.log(
    `📦 Static assets: http://localhost:${port}/static/* -> https://us-assets.i.posthog.com/static/*`,
  );
  console.log(
    `🎯 API endpoints: http://localhost:${port}/* -> https://us.i.posthog.com/*`,
  );
  console.log(`📁 Events will be saved to: data/events.jsonl`);
  console.log(`🎬 Recordings will be saved to: data/recordings.jsonl`);
  console.log(`🔍 Health check: http://localhost:${port}/health`);
});
