const fs = require("fs").promises;
const https = require("https");
const zlib = require("zlib");

require("dotenv").config();

class PostHogSessionReplay {
  constructor(config) {
    this.config = {
      recordingId: config.recordingId,
      targetHost: config.targetHost || "us.i.posthog.com",
      projectKey: config.projectKey || process.env.POSTHOG_API_KEY,
      timestampOffset: config.timestampOffset || 3 * 86400000, // 3 days
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
      }
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
  async modifyAndRecompress(
    originalRecording,
    newSessionIdMap,
    newWindowIdMap
  ) {
    console.log("🔍 Analyzing original recording...");

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
    const originalWindowId = originalEvent?.properties?.$window_id;

    if (!newSessionIdMap.has(originalSessionId)) {
      newSessionIdMap.set(originalSessionId, this.generateNewUUID());
    }
    if (!newWindowIdMap.has(originalWindowId)) {
      newWindowIdMap.set(originalWindowId, this.generateNewUUID());
    }
    const newSessionId = newSessionIdMap.get(originalSessionId);
    const newWindowId = newWindowIdMap.get(originalWindowId);

    console.log(`📝 Session modification:`);
    console.log(`   Original session: ${originalSessionId}`);
    console.log(`   New session:      ${newSessionId}`);
    console.log(`   User ID:          ${originalUserId} (preserved)`);

    // Clone and modify the decompressed data
    const modifiedEvents = JSON.parse(
      JSON.stringify(originalRecording.decompressed)
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
        event.timestamp = event.timestamp - this.config.timestampOffset;

        // Update snapshot timestamps if present
        if (
          event.properties.$snapshot_data &&
          Array.isArray(event.properties.$snapshot_data)
        ) {
          event.properties.$snapshot_data.forEach((snapshot, snapshotIndex) => {
            snapshot.timestamp =
              snapshot.timestamp - this.config.timestampOffset;
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

  async sendToPostHog(compressedData, endpoint = "/s/", verbose = true) {
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
      path: `${endpoint}?${queryParams.toString()}`,
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
          if (verbose) {
            console.log(`📥 Response: HTTP ${res.statusCode}`);
            if (responseBody && responseBody.length < 500) {
              console.log(`📥 Response Body: ${responseBody}`);
            }
          }
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

      req.on("error", reject);
      req.write(compressedData);
      req.end();
    });
  }

  async sendEventsToPostHog(batchData) {
    if (!batchData || !batchData.batch || batchData.batch.length === 0) {
      return null;
    }

    const eventCount = batchData.batch.length;
    console.log(`📊 Sending batch of ${eventCount} events to PostHog...\n`);

    try {
      // send an arry with historical_migration flag
      const url = "https://us.i.posthog.com/batch/";

      const body = {
        api_key: process.env.POSTHOG_API_KEY || this.config.projectKey,
        historical_migration: true,
        batch: batchData.batch,
      };

      (async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const data = await res.text(); // or res.json()
        console.log(JSON.stringify(body, null, 2));
        console.log("Status:", res.status);
        console.log("Response:", data);
      })();

      // console.log(`✅ Batch sent successfully\n`);
      // return response;
    } catch (error) {
      console.error(`❌ Failed to send batch: ${error.message}\n`);
      throw error;
    }
  }

  async loadAndModifyEvents(originalSessionId, newSessionId) {
    try {
      // Load events
      const eventsData = await fs.readFile("./data/events.jsonl", "utf8");
      const eventEntries = eventsData
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      if (eventEntries.length === 0) {
        console.log("⚠️  No events found in events.jsonl");
        return null;
      }

      console.log(
        `🔍 Looking for events with session ID: ${originalSessionId}`
      );
      console.log(`📊 Total event entries in file: ${eventEntries.length}`);

      // Collect all events from all batches that match the session
      const allModifiedEvents = [];
      const seenSessionIds = new Set();

      // each line in events.jsonl
      for (const entry of eventEntries) {
        let eventData = entry.data;

        // Skip empty entries
        if (!eventData || !Array.isArray(eventData)) {
          continue;
        }

        // get batch timeset and offset
        const batchTimestamp = entry.originalTimestamp
          ? new Date(
              entry.originalTimestamp - this.config.timestampOffset
            ).toISOString()
          : new Date(Date.now() - this.config.timestampOffset).toISOString();

        // process each event in batch
        for (const event of eventData) {
          const sessionId = event.properties?.$session_id;
          if (sessionId) {
            seenSessionIds.add(sessionId);

            // Only process events matching the original session ID
            if (sessionId === originalSessionId) {
              // dupe event
              const modified = JSON.parse(JSON.stringify(event));

              // use new sesh id
              if (modified.properties && modified.properties.$session_id) {
                modified.properties.$session_id = newSessionId;
              }

              // use the batch timestamp (with the offset applied)
              modified.timestamp = batchTimestamp;

              // delete the original timestamp
              delete modified.uuid;
              delete modified.offset;
              modified.event = `replayed_event_${Date.now().toString()}_${
                modified.event
              }`;

              allModifiedEvents.push(modified);
            }
          }
        }
      }

      // Debug: show what session IDs we found
      if (seenSessionIds.size > 0) {
        console.log(
          `🔍 Found ${seenSessionIds.size} unique session ID(s) in events:`
        );
        Array.from(seenSessionIds)
          .slice(0, 10)
          .forEach((id) => {
            console.log(`   - ${id}`);
          });
        if (seenSessionIds.size > 10) {
          console.log(`   ... and ${seenSessionIds.size - 10} more`);
        }
      }

      if (allModifiedEvents.length === 0) {
        console.log(
          `⚠️  No events found matching session ${originalSessionId}`
        );
        return null;
      }

      console.log(
        `✅ Found ${allModifiedEvents.length} events for session ${originalSessionId}`
      );

      // need batch for histroical imports
      return {
        // array for batch
        batch: allModifiedEvents,
        historical_migration: true,
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("⚠️  events.jsonl file not found, skipping events");
        return null;
      }
      throw error;
    }
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
                `🔄 Re-compressed DOM snapshot back to original format`
              );
            } catch (error) {
              console.warn(
                "Failed to re-compress DOM snapshot:",
                error.message
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
        "utf8"
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

      const newSessionIds = new Map();
      const newWindowIds = new Map();
      const recordingResponses = [];

      recordings.forEach(async (recording) => {
        // Modify and recompress
        const { compressed, identifiers } = await this.modifyAndRecompress(
          recording,
          newSessionIds,
          newWindowIds
        );

        // Send session recording to PostHog
        console.log("🚀 Sending session recording to PostHog...");
        const recordingResponse = await this.sendToPostHog(compressed);
        recordingResponses.push(recordingResponse);

        console.log(`\n✅ New session created successfully!`);
        console.log(
          `📈 Recording Response: HTTP ${recordingResponses
            .map((r) => r.status)
            .join(", ")}`
        );
        console.log(`🔍 Session details:`);
        console.log(`   Original Session: ${identifiers.originalSessionId}`);
        console.log(`   New Session:      ${identifiers.newSessionId}`);
        console.log(
          `   User ID:          ${identifiers.originalUserId} (same user)`
        );
      });

      // Find and modify events for this session
      newSessionIds.forEach(async (newSessionId, originalSessionId) => {
        const batchData = await this.loadAndModifyEvents(
          originalSessionId,
          newSessionId
        );

        // Send batch if events were found
        if (batchData) {
          await this.sendEventsToPostHog(batchData);
        }
      });

      return {
        success: true,
        recordingResponses,
      };
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
        case "recording-id":
          config.recordingId = value;
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

  if (!config.projectKey && !process.env.POSTHOG_API_KEY) {
    console.error("❌ Error: PostHog project key required");
    console.log(
      "Usage: node replay-new-session.js --key YOUR_PROJECT_KEY --recording-id YOUR_RECORDING_ID [options]"
    );
    console.log("");
    console.log(
      "This script creates a new session for the same user from captured recordings."
    );
    console.log(
      "It preserves the original user ID but generates a new session UUID."
    );
    console.log("");
    console.log("Options:");
    console.log("  --key PROJECT_KEY        PostHog project key (required)");
    console.log("  --recording-id RECORDING_ID Recording ID (required)");
    console.log(
      "  --timestamp-offset MS    Milliseconds to offset timestamps (negative for past)"
    );
    console.log("");
    console.log("Examples:");
    console.log(
      "  node replay-new-session.js --key phc_abc123 --recording-id 1234567890"
    );
    console.log(
      "  node replay-new-session.js --key phc_abc123 --recording-id 1234567890 --timestamp-offset -86400000  # Yesterday"
    );
    process.exit(1);
  }

  if (!config.recordingId) {
    console.error("❌ Error: Recording ID required");
    console.log(
      "Usage: node replay-new-session.js --recording-id YOUR_RECORDING_ID"
    );
    process.exit(1);
  }

  const replay = new PostHogSessionReplay(config);
  await replay.replaySession();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = PostHogSessionReplay;
