const fs = require("fs").promises;
const https = require("https");
const zlib = require("zlib");
const gzip = require("gzip-js");

class PostHogSessionReplay {
  constructor(config) {
    this.config = {
      targetHost: config.targetHost || "us.i.posthog.com",
      projectKey: config.projectKey,
      ssl: config.ssl !== false,
      ...config,
    };
  }

  // Generate new UUID for session (keeping original user ID)
  generateNewUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  }

  // Fix undefined attributes in DOM nodes to prevent PostHog UI errors
  ensureDOMAttributesExist(events) {
    events.forEach((event) => {
      if (event.properties && event.properties.$snapshot_data) {
        event.properties.$snapshot_data.forEach((snapshot) => {
          if (snapshot.type === 2 && snapshot.data) {
            // Type 2 is DOM snapshot, fix any undefined attributes
            this.fixDOMNodeAttributes(snapshot.data);
          }
        });
      }
    });
  }

  // Recursively fix DOM node attributes
  fixDOMNodeAttributes(data) {
    try {
      // Parse DOM data if it's a string
      const domData = typeof data === "string" ? JSON.parse(data) : data;

      if (domData && domData.node) {
        this.fixNodeAttributes(domData.node);
      }
    } catch (error) {
      // If parsing fails, skip this DOM data
      console.warn("Failed to parse DOM data:", error.message);
    }
  }

  // Fix attributes for a single node and its children
  fixNodeAttributes(node) {
    if (!node) return;

    // Ensure attributes exists for element nodes (type 2)
    if (node.type === 2 && node.attributes === undefined) {
      node.attributes = {};
    }

    // Recursively fix child nodes
    if (node.childNodes && Array.isArray(node.childNodes)) {
      node.childNodes.forEach((child) => {
        this.fixNodeAttributes(child);
      });
    }
  }

  // Modify the decompressed data: new session ID, keep original user ID
  async modifyAndRecompress(originalRecording) {
    console.log("🔍 Analyzing original recording...");

    // Generate new session and window IDs (but keep original user)
    const newSessionId = this.generateNewUUID();
    const newWindowId = this.generateNewUUID();

    // Work with the decompressed data
    if (
      !originalRecording.decompressed ||
      !Array.isArray(originalRecording.decompressed)
    ) {
      throw new Error("No decompressed data found in recording");
    }

    // Extract original user ID to preserve it
    const originalEvent = originalRecording.decompressed[0];
    const originalUserId = originalEvent?.properties?.distinct_id;
    const originalSessionId = originalEvent?.properties?.$session_id;

    console.log(`📝 Session modification:`);
    console.log(`   Original session: ${originalSessionId}`);
    console.log(`   New session:      ${newSessionId}`);
    console.log(`   User ID:          ${originalUserId} (preserved)`);

    // Clone and modify the decompressed data
    const modifiedEvents = JSON.parse(
      JSON.stringify(originalRecording.decompressed),
    );

    // Fix potential undefined attributes in DOM nodes to prevent PostHog UI errors
    this.ensureDOMAttributesExist(modifiedEvents);

    // Re-compress nested DOM snapshots that were originally compressed
    this.recompressNestedSnapshots(modifiedEvents);

    // Calculate base timestamp (default to now, or specified offset)
    const now = Date.now();
    const baseTimestamp = this.config.timestampOffset
      ? now + this.config.timestampOffset
      : now;

    modifiedEvents.forEach((event, eventIndex) => {
      if (event.properties) {
        // Update session identifiers (but keep original user ID)
        if (event.properties.$session_id) {
          event.properties.$session_id = newSessionId;
        }
        if (event.properties.$window_id) {
          event.properties.$window_id = newWindowId;
        }
        // Keep original distinct_id unchanged

        // Update event timestamp
        event.timestamp = new Date(
          baseTimestamp + eventIndex * 1000,
        ).toISOString();

        // Update snapshot timestamps if present
        if (
          event.properties.$snapshot_data &&
          Array.isArray(event.properties.$snapshot_data)
        ) {
          event.properties.$snapshot_data.forEach((snapshot, snapshotIndex) => {
            snapshot.timestamp =
              baseTimestamp + eventIndex * 1000 + snapshotIndex * 100;
          });
        }
      }
    });

    console.log(`✅ Modified ${modifiedEvents.length} events`);

    // Recompress the modified data (Node.js zlib is closer to original than gzip-js)
    const modifiedJson = JSON.stringify(modifiedEvents);
    const compressed = zlib.gzipSync(Buffer.from(modifiedJson, "utf8"));

    return {
      compressed,
      modifiedEvents,
      identifiers: {
        newSessionId,
        newWindowId,
        originalUserId,
        originalSessionId,
      },
    };
  }

  async sendToPostHog(compressedData) {
    const queryParams = new URLSearchParams({
      ip: "0",
      _: Date.now().toString(),
      ver: "1.265.0",
      compression: "gzip-js",
      // Note: Original PostHog requests do NOT include token or beacon parameters
    });

    const options = {
      hostname: this.config.targetHost,
      port: 443,
      path: `/s/?${queryParams.toString()}`,
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": compressedData.length,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept: "*/*",
        Origin: "http://localhost:3000",
        Referer: "http://localhost:3000/",
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          console.log(`📥 Response: HTTP ${res.statusCode}`);
          console.log(`📥 Response Body: ${responseBody || "(empty)"}`);
          console.log(`📥 Response Headers:`);
          Object.entries(res.headers).forEach(([key, value]) => {
            console.log(`     ${key}: ${value}`);
          });
          console.log("");

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              status: res.statusCode,
              body: responseBody,
              headers: res.headers,
            });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
          }
        });
      });

      // 🔍 LOG FULL REQUEST DETAILS FOR COMPARISON
      console.log("\n📤 REPLAY SCRIPT REQUEST DETAILS:");
      console.log(`   Method: ${options.method}`);
      console.log(`   Host: ${options.hostname}:${options.port}`);
      console.log(`   Path: ${options.path}`);
      console.log(`   Headers:`);
      Object.entries(options.headers).forEach(([key, value]) => {
        console.log(`     ${key}: ${value}`);
      });
      console.log(`   Body Size: ${compressedData.length} bytes`);
      console.log("");

      req.on("error", reject);
      req.write(compressedData);
      req.end();
    });
  }

  // Re-compress nested DOM snapshots that were originally compressed
  recompressNestedSnapshots(events) {
    events.forEach((event) => {
      if (event.properties && event.properties.$snapshot_data) {
        event.properties.$snapshot_data.forEach((snapshot) => {
          if (
            snapshot.type === 2 &&
            snapshot._original_compressed &&
            typeof snapshot.data === "string"
          ) {
            try {
              // Re-compress the DOM data back to its original gzipped latin1 format
              const buffer = zlib.gzipSync(Buffer.from(snapshot.data, "utf8"));
              snapshot.data = buffer.toString("latin1");
              // Remove the flag since we've restored original format
              delete snapshot._original_compressed;
              console.log(
                `🔄 Re-compressed DOM snapshot back to original format`,
              );
            } catch (error) {
              console.warn(
                "Failed to re-compress DOM snapshot:",
                error.message,
              );
            }
          }
        });
      }
    });
  }

  async replaySession() {
    console.log("🎬 Creating new session from captured recording...\n");

    try {
      // Load recordings
      const recordingsData = await fs.readFile(
        "./data/recordings.jsonl",
        "utf8",
      );
      const recordings = recordingsData
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      if (recordings.length === 0) {
        console.log("❌ No recordings found in recordings.jsonl");
        return;
      }

      // Find a good recording with session data
      const testRecording = recordings.find(
        (rec) =>
          rec.decompressed &&
          Array.isArray(rec.decompressed) &&
          rec.decompressed.length > 0 &&
          rec.decompressed.some(
            (event) =>
              event.properties?.$session_id &&
              event.properties?.distinct_id &&
              event.properties?.$snapshot_data,
          ),
      );

      if (!testRecording) {
        console.log("❌ No suitable recording found with session data");
        return;
      }

      console.log(
        `✅ Found recording with ${testRecording.decompressed.length} events`,
      );

      // Modify and recompress
      const { compressed, identifiers } =
        await this.modifyAndRecompress(testRecording);

      // Send to PostHog
      console.log("🚀 Sending to PostHog...");
      const response = await this.sendToPostHog(compressed);

      console.log(`\n✅ New session created successfully!`);
      console.log(`📈 Response: HTTP ${response.status}`);
      console.log(`🔍 Session details:`);
      console.log(`   Original Session: ${identifiers.originalSessionId}`);
      console.log(`   New Session:      ${identifiers.newSessionId}`);
      console.log(
        `   User ID:          ${identifiers.originalUserId} (same user)`,
      );
      console.log(`   Timestamp:        ${new Date().toLocaleString()}`);

      return { success: true, identifiers, response };
    } catch (error) {
      console.error("\n❌ Session replay failed:", error.message);
      throw error;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const config = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace("--", "");
    const value = args[i + 1];

    if (key && value) {
      switch (key) {
        case "host":
          config.targetHost = value;
          break;
        case "key":
          config.projectKey = value;
          break;
        case "timestamp-offset":
          config.timestampOffset = parseInt(value);
          break;
      }
    }
  }

  if (!config.projectKey && !process.env.POSTHOG_PROJECT_KEY) {
    console.error("❌ Error: PostHog project key required");
    console.log(
      "Usage: node replay-new-session.js --key YOUR_PROJECT_KEY [options]",
    );
    console.log("");
    console.log(
      "This script creates a new session for the same user from captured recordings.",
    );
    console.log(
      "It preserves the original user ID but generates a new session UUID.",
    );
    console.log("");
    console.log("Options:");
    console.log("  --key PROJECT_KEY        PostHog project key (required)");
    console.log(
      "  --timestamp-offset MS    Milliseconds to offset timestamps (negative for past)",
    );
    console.log("");
    console.log("Examples:");
    console.log("  node replay-new-session.js --key phc_abc123");
    console.log(
      "  node replay-new-session.js --key phc_abc123 --timestamp-offset -86400000  # Yesterday",
    );
    process.exit(1);
  }

  config.projectKey = config.projectKey || process.env.POSTHOG_PROJECT_KEY;

  const replay = new PostHogSessionReplay(config);
  await replay.replaySession();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = PostHogSessionReplay;
