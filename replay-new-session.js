const fs = require("fs").promises;
const https = require("https");
const zlib = require("zlib");

require("dotenv").config();

class PostHogSessionReplay {
  constructor(config) {
    this.config = {
      targetHost: config.targetHost || "us.i.posthog.com",
      projectKey: config.projectKey || process.env.POSTHOG_API_KEY,
      ssl: config.ssl !== false,
      timestampOffset: config.timestampOffset || 86400000, // 24 hours
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

  async sendEventsToPostHog(events) {
    if (!events || events.length === 0) {
      return null;
    }

    console.log(`📊 Sending ${events.length} events to PostHog...\n`);

    const responses = [];

    // Send each event individually
    for (const event of events) {
      const eventName = event.event || event.properties?.event || "unknown";
      const timestamp = event.timestamp || "unknown";

      console.log(`   📤 Sending: ${eventName} at ${timestamp}`);

      // Compress single event
      const eventJson = JSON.stringify(event);
      const compressed = zlib.gzipSync(Buffer.from(eventJson, "utf8"));

      try {
        const response = await this.sendToPostHog(compressed, "/e/", false);
        responses.push(response);
      } catch (error) {
        console.error(
          `   ❌ Failed to send event ${eventName}: ${error.message}`
        );
        responses.push({ error: error.message, eventName });
      }
    }

    console.log(""); // Empty line after all events

    return responses;
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
        return [];
      }

      console.log(
        `🔍 Looking for events with session ID: ${originalSessionId}`
      );
      console.log(`📊 Total event entries in file: ${eventEntries.length}`);

      // Filter events that belong to the original session
      const sessionEvents = [];
      const seenSessionIds = new Set();

      for (const entry of eventEntries) {
        let eventData = entry.data;

        // Skip empty entries
        if (
          !eventData ||
          (typeof eventData === "object" && Object.keys(eventData).length === 0)
        ) {
          continue;
        }

        // Handle compressed events (stored as Buffer)
        if (entry.data && entry.data.type === "Buffer" && entry.data.data) {
          try {
            const buffer = Buffer.from(entry.data.data);
            const decompressed = zlib.gunzipSync(buffer);
            eventData = JSON.parse(decompressed.toString("utf8"));
          } catch (err) {
            console.warn(
              `⚠️  Could not decompress event entry: ${err.message}`
            );
            continue;
          }
        }

        // Helper function to check and collect events
        const checkEvent = (event) => {
          const sessionId = event.properties?.$session_id;
          if (sessionId) {
            seenSessionIds.add(sessionId);
            if (sessionId === originalSessionId) {
              // Extract timestamp from event (could be in different places)
              let eventTimestamp = event.timestamp;
              if (!eventTimestamp && event.properties?.$time) {
                // $time is in seconds, convert to milliseconds for Date
                eventTimestamp = new Date(
                  event.properties.$time * 1000
                ).toISOString();
              }
              if (!eventTimestamp) {
                // Fall back to entry timestamp
                eventTimestamp = entry.originalTimestamp
                  ? new Date(entry.originalTimestamp).toISOString()
                  : new Date().toISOString();
              }

              sessionEvents.push({
                ...event,
                _originalTimestamp: eventTimestamp,
                _entryTimestamp: entry.originalTimestamp,
              });
            }
          }
        };

        // Handle batch events format (array of events)
        if (Array.isArray(eventData)) {
          eventData.forEach(checkEvent);
        }
        // Handle batch format with batch property
        else if (eventData && Array.isArray(eventData.batch)) {
          eventData.batch.forEach(checkEvent);
        }
        // Handle single event format
        else if (eventData && eventData.properties) {
          checkEvent(eventData);
        }
        // Handle PostHog event format (event property at top level)
        else if (eventData && eventData.event && eventData.properties) {
          checkEvent(eventData);
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

      if (sessionEvents.length === 0) {
        console.log(
          `⚠️  No events found matching session ${originalSessionId}`
        );
        return [];
      }

      console.log(
        `✅ Found ${sessionEvents.length} events for session ${originalSessionId}`
      );

      // Sort events by timestamp
      sessionEvents.sort(
        (a, b) =>
          new Date(a._originalTimestamp || a.timestamp) -
          new Date(b._originalTimestamp || b.timestamp)
      );

      // Modify events with new session ID and updated timestamps
      const modifiedEvents = sessionEvents.map((event, index) => {
        const modified = JSON.parse(JSON.stringify(event));

        if (modified.properties) {
          // Update session ID
          if (modified.properties.$session_id) {
            modified.properties.$session_id = newSessionId;
          }
          // Keep original distinct_id unchanged
        }

        // Update timestamp with same offset as recordings (subtract offset directly)
        if (modified.timestamp) {
          modified.timestamp = new Date(new Date(modified.timestamp).getTime() - this.config.timestampOffset).toISOString();
        }

        // Remove temporary fields
        delete modified._originalTimestamp;
        delete modified._entryTimestamp;

        return modified;
      });

      return modifiedEvents;
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("⚠️  events.jsonl file not found, skipping events");
        return [];
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

        // Find and modify events for this session
        const modifiedEvents = await this.loadAndModifyEvents(
          identifiers.originalSessionId,
          identifiers.newSessionId
        );

        // Send session recording to PostHog
        console.log("🚀 Sending session recording to PostHog...");
        const recordingResponse = await this.sendToPostHog(compressed);
        recordingResponses.push(recordingResponse);

        // Send events if any were found
        if (modifiedEvents.length > 0) {
          await this.sendEventsToPostHog(modifiedEvents);
        }

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
        if (modifiedEvents.length > 0) {
          console.log(`   Events sent:      ${modifiedEvents.length}`);
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
      "Usage: node replay-new-session.js --key YOUR_PROJECT_KEY [options]"
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
    console.log(
      "  --timestamp-offset MS    Milliseconds to offset timestamps (negative for past)"
    );
    console.log("");
    console.log("Examples:");
    console.log("  node replay-new-session.js --key phc_abc123");
    console.log(
      "  node replay-new-session.js --key phc_abc123 --timestamp-offset -86400000  # Yesterday"
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
