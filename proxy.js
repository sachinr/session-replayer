const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");

const app = express();
const port = 3001;

// Paths to JSONL files
const EVENTS_FILE = path.join(__dirname, "data", "events.jsonl");
const RECORDINGS_FILE = path.join(__dirname, "data", "recordings.jsonl");

// Ensure data directory exists
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Enable CORS for all routes
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
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

    // Only parse if not compressed
    const encoding = req.headers["content-encoding"];
    if (!encoding && buffer.length > 0) {
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
      req.body = buffer;
    }

    next();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    next(err);
  });
});

// Helper function to decompress nested DOM snapshots
async function decompressNestedSnapshots(data) {
  try {
    // If it's an array, process each item
    if (Array.isArray(data)) {
      return await Promise.all(
        data.map((item) => decompressNestedSnapshots(item))
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
                  `Could not decompress DOM snapshot: ${err.message}`
                );
                return {
                  ...snapshot,
                  _decompression_error: err.message,
                };
              }
            }
            return snapshot;
          })
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

// Save event to JSONL file
async function saveEventToFile(eventData, headers, query) {
  try {
    // Extract event type from the data - try multiple possible field names
    const eventType =
      eventData.event ||
      eventData.type ||
      eventData.name ||
      eventData.$event ||
      "unknown";

    // Parse timestamp safely
    let eventTimestamp = new Date();
    if (eventData.timestamp) {
      try {
        eventTimestamp = new Date(eventData.timestamp);
        if (isNaN(eventTimestamp.getTime())) {
          eventTimestamp = new Date();
        }
      } catch (error) {
        console.log(
          `Invalid timestamp: ${eventData.timestamp}, using current time`
        );
        eventTimestamp = new Date();
      }
    }

    // Create event entry in JSONL format
    const eventEntry = {
      timestamp: eventTimestamp.toISOString(),
      originalTimestamp: eventTimestamp.getTime(),
      type: "event",
      data: eventData,
      headers: headers,
      query: query,
    };

    // Append to events.jsonl file
    const line = JSON.stringify(eventEntry) + "\n";
    fs.appendFileSync(EVENTS_FILE, line, "utf8");

    console.log(`📊 Event saved to file for behavior: ${session.behaviorId}`);
  } catch (error) {
    console.error("Error saving event to file:", error);
  }
}

// Save recording to JSONL file
async function saveRecordingToFile(
  originalData,
  decompressedData,
  headers,
  query
) {
  try {
    const timestamp = new Date();

    // Create recording entry in JSONL format
    const recordingEntry = {
      timestamp: timestamp.toISOString(),
      originalTimestamp: timestamp.getTime(),
      type: "recording",
      data: originalData,
      decompressed: decompressedData || null,
      headers: headers,
      query: query,
    };

    // Append to recordings.jsonl file
    const line = JSON.stringify(recordingEntry) + "\n";
    fs.appendFileSync(RECORDINGS_FILE, line, "utf8");

    console.log(
      `🎥 Recording saved to file for behavior: ${session.behaviorId}`
    );
  } catch (error) {
    console.error("Error saving recording to file:", error);
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
        `📤 Sending compressed data (${encoding}): ${req.rawBody.length} bytes`
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

    // Send request body if POST
    if (postData) {
      proxyReq.write(postData);
    }
    proxyReq.end();
  });
}

// API endpoint to start a recording session
app.post("/api/recording/start", async (req, res) => {
  try {
    const { behaviorId, sessionId } = req.body;

    if (!behaviorId || !sessionId) {
      return res
        .status(400)
        .json({ error: "behaviorId and sessionId are required" });
    }

    console.log(
      `🎬 Started recording session for behavior: ${behaviorId} - Session: ${sessionId}`
    );

    res.json({
      success: true,
      behaviorId: behaviorId,
      sessionId: sessionId,
    });
  } catch (error) {
    console.error("Error starting recording session:", error);
    res.status(500).json({ error: "Failed to start recording session" });
  }
});

// API endpoint to stop a recording session
app.post("/api/recording/stop", async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const behaviorId = req.body.behaviorId;

    console.log(
      `🛑 Stopped recording session for behavior: ${behaviorId} - Session: ${sessionId}`
    );

    res.json({
      success: true,
      message: "Recording session stopped",
    });
  } catch (error) {
    console.error("Error stopping recording session:", error);
    res.status(500).json({ error: "Failed to stop recording session" });
  }
});

// API endpoint to get recording session status
app.get("/api/recording/status/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    res.json({
      sessionId: sessionId,
      status: "ACTIVE",
    });
  } catch (error) {
    console.error("Error getting recording session status:", error);
    res.status(500).json({ error: "Failed to get recording session status" });
  }
});

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

// Handle PostHog events endpoint
app.post("/i/v0/e/*", async (req, res) => {
  console.log(`📊 PostHog Event: ${req.path}`);
  console.log(`📊 Content-Type: ${req.headers["content-type"]}`);
  console.log(`📊 Content-Encoding: ${req.headers["content-encoding"]}`);

  // Get current behavior info for debugging
  // Always record the raw data - don't be smart about it
  console.log(
    `📊 Raw data size: ${req.rawBody ? req.rawBody.length : 0} bytes`
  );

  if (req.rawBody && req.rawBody.length > 0) {
    // Try to decompress and parse for logging, but always save raw data
    try {
      const decompressed = zlib.gunzipSync(req.rawBody);
      const parsedData = JSON.parse(decompressed.toString());
      console.log(`📊 Decompressed data:`, parsedData);

      // Save the decompressed data to file
      await saveEventToFile(parsedData, req.headers, req.query);
    } catch (error) {
      console.log(`📊 Failed to decompress, saving raw data:`, error.message);

      // If decompression fails, save the raw data as a string
      const rawDataString = req.rawBody.toString("base64");
      await saveEventToFile(
        { rawData: rawDataString, error: "Failed to decompress" },
        req.headers,
        req.query
      );
    }
  } else if (req.body && Object.keys(req.body).length > 0) {
    console.log(`📊 ${behaviorInfo} - Recording parsed PostHog data`);
    console.log(`📊 Parsed data:`, req.body);
    await saveEventToFile(req.body, req.headers, req.query);
  } else {
    console.log(`📊 ${behaviorInfo} - No data to record`);
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
    await saveRecordingToFile(req.body, req.body, req.headers, req.query);
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
        await saveRecordingToFile(
          {
            type: "Buffer",
            data: Array.from(originalData), // Keep original format for PostHog compatibility
          },
          await decompressNestedSnapshots(parsedData), // Add fully readable format for analysis
          req.headers,
          req.query
        );

        console.log(
          `🎥 Recording saved with dual storage: ${originalData.length} bytes compressed -> ${decompressedData.length} bytes decompressed`
        );
      } else {
        // Fallback: save as original format
        await saveRecordingToFile(
          {
            type: "Buffer",
            data: Array.from(originalData),
          },
          null,
          req.headers,
          req.query
        );
        console.log(
          `🎥 Recording saved as original: ${originalData.length} bytes`
        );
      }
    } catch (error) {
      console.error("Error processing recording data:", error);
      // Fallback: save as original format
      await saveRecordingToFile(
        {
          type: "Buffer",
          data: Array.from(req.rawBody),
        },
        null,
        req.headers,
        req.query
      );
    }
  }

  console.log(
    `🎥 Recording data: ${req.rawBody ? req.rawBody.length : 0} bytes`
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
      proxy: "Behavior-Aware PostHog Proxy",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  console.log(`🔄 Generic GET: ${req.path}`);
  await proxyRequest(req, res, "us.i.posthog.com");
});

app.listen(port, () => {
  console.log(
    `🚀 Behavior-Aware PostHog Proxy running on http://localhost:${port}`
  );
  console.log(
    `📦 Static assets: http://localhost:${port}/static/* -> https://us-assets.i.posthog.com/static/*`
  );
  console.log(
    `🎯 API endpoints: http://localhost:${port}/* -> https://us.i.posthog.com/*`
  );
  console.log(`🎬 Recording sessions will be saved to JSONL files`);
  console.log(`🔍 Health check: http://localhost:${port}/health`);
});
