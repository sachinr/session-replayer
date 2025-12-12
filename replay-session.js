import fs from "fs/promises";
import https from "https";
import zlib from "zlib";
import dotenv from "dotenv";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import FeatureFlagManager from "./feature-flag-manager.js";
import generationConfig from "./generation-config.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

class PostHogSessionReplay {
  constructor(config) {

    this.propertiesToRandomize = new Map();

    Object.keys(generationConfig.randomized_ids).forEach((id) => {
      this.propertiesToRandomize.set(id, generationConfig.randomized_ids[id] === "uuid" ? crypto.randomUUID() : Math.floor(Math.random() * 10000));
    })

    this.config = {
      recordingId: config.recordingId,
      targetHost: config.targetHost || "us.i.posthog.com",
      projectKey: config.projectKey || process.env.POSTHOG_API_KEY,
      timestamp: config.timestamp,
      sessionId: config.sessionId,
      userId: config.user.id,
      anonId: crypto.randomUUID(),
      groups: config.user.groups,
      email: config.user.email,
      runId: config.runId,
      ...config,
    };
    this.flagManager = new FeatureFlagManager();
    this.flagAssignments = null;
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
    // console.log("🔍 Analyzing original recording...");

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
    const originalTimestamp =
      originalRecording?.decompressed[0]?.properties?.$snapshot_data[0]
        ?.timestamp;

    if (!newSessionIdMap.has(originalSessionId)) {
      newSessionIdMap.set(originalSessionId, this.config.sessionId);
    }
    if (!newWindowIdMap.has(originalWindowId)) {
      newWindowIdMap.set(originalWindowId, crypto.randomUUID());
    }
    const newSessionId = newSessionIdMap.get(originalSessionId);
    const newWindowId = newWindowIdMap.get(originalWindowId);

    // console.log(`📝 Session modification:`);
    // console.log(`   Original session: ${originalSessionId}`);
    // console.log(`   New session:      ${newSessionId}`);
    // console.log(`   User ID:          ${originalUserId} (preserved)`);

    // Clone and modify the decompressed data
    const chunks = JSON.parse(JSON.stringify(originalRecording.decompressed));

    // Fix potential undefined attributes in DOM nodes to prevent PostHog UI errors
    this.ensureDOMAttributesExist(chunks);

    // Re-compress nested DOM snapshots that were originally compressed
    this.recompressNestedSnapshots(chunks);

    chunks.forEach((chunk) => {
      if (chunk.properties) {
        // Update session identifiers (but keep original user ID)
        if (chunk.properties.$session_id) {
          chunk.properties.$session_id = newSessionId;
        }
        if (chunk.properties.$window_id) {
          chunk.properties.$window_id = newWindowId;
        }
        if (chunk.properties.$is_identified) {
          chunk.properties.distinct_id = this.config.userId;
          chunk.properties.$user_id = this.config.userId;
        } else {
          chunk.properties.distinct_id = this.config.anonId;
          chunk.properties.$user_id = this.config.anonId;
        }

        // Update snapshot timestamps if present
        if (
          chunk.properties.$snapshot_data &&
          Array.isArray(chunk.properties.$snapshot_data)
        ) {
          chunk.properties.$snapshot_data.forEach((snapshot) => {
            // const offset = snapshot.timestamp - originalTimestamp;
            snapshot.timestamp = snapshot.timestamp - 86400000;
          });
        }
      }
    });

    // console.log(`✅ Modified ${chunks.length} chunks`);

    // Recompress the modified data (Node.js zlib is closer to original than gzip-js)
    const modifiedJson = JSON.stringify(chunks);
    const compressed = zlib.gzipSync(Buffer.from(modifiedJson, "utf8"));

    return {
      compressed,
      chunks,
      identifiers: {
        newSessionId,
        newWindowId,
        originalUserId,
        originalSessionId,
      },
    };
  }

  async sendToPostHog({
    compressedData,
    endpoint = "/s/",
    verbose = true,
    dryRun = true,
  } = {}) {
    const queryParams = new URLSearchParams({
      ip: "0",
      _: this.config.timestamp.toString(),
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

    if (dryRun) {
      // console.log(
      //   `📊 Dry run: Skipping sending session recording to PostHog...\n`
      // );
      return;
    }

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          // if (verbose) {
            // console.log(`📥 Response: HTTP ${res.statusCode}`);
            // if (responseBody && responseBody.length < 500) {
              // console.log(`📥 Response Body: ${responseBody}`);
            // }
          // }
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

  async sendEventsToPostHog({ batchData, dryRun = true } = {}) {
    if (!batchData || !batchData.batch || batchData.batch.length === 0) {
      return null;
    }

    const eventCount = batchData.batch.length;

    if (dryRun) {
      // console.log(
      //   `📊 Dry run: Skipping sending batch of ${eventCount} events to PostHog...\n`
      // );
      return;
    }

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
        console.log(`📊 Batch sent successfully\n`);
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
      let eventsData = await fs.readFile(
        path.join(__dirname, "data", `${this.config.recordingId}-events.jsonl`),
        "utf8"
      );
      eventsData = eventsData.replaceAll(
        /phc_[a-zA-Z0-9]+/g,
        this.config.projectKey
      );
      const eventEntries = eventsData
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      if (eventEntries.length === 0) {
        console.log("⚠️  No events found in events.jsonl");
        return null;
      }

      // console.log(
        // `🔍 Looking for events with session ID: ${originalSessionId}`
      // );
      // console.log(`📊 Total event entries in file: ${eventEntries.length}`);

      // Collect all events from all batches that match the session
      let allModifiedEvents = [];
      const seenSessionIds = new Set();

      // each line in events.jsonl
      for (const entry of eventEntries) {
        let eventData = entry.data;

        // Skip empty entries
        if (!eventData) {
          continue;
        }

        if (!Array.isArray(eventData)) {
          eventData = [eventData];
        }

        // get batch timeset and offset
        const batchTimestamp = new Date(this.config.timestamp).toISOString();

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
              modified.properties.$session_id = newSessionId;
              if (modified.properties.$is_identified) {
                modified.properties.distinct_id = this.config.userId;
                modified.properties.$user_id = this.config.userId;
              } else {
                modified.properties.distinct_id = this.config.anonId;
                modified.properties.$user_id = this.config.anonId;
              }

              // use the batch timestamp (with the offset applied)
              modified.timestamp = batchTimestamp;

              modified.properties.$lib = "posthog-session-replay";
              modified.properties.run_id = this.config.runId;

              delete modified.uuid;
              delete modified.offset;

              // add flag properties if flags are assigned
              if (this.flagAssignments && Object.keys(this.flagAssignments).length > 0) {
                this.flagManager.injectFlagProperties(modified, this.flagAssignments);
              }

              // within the context of a session 
              // replace all instances of a property with a randomized value
              // keep track of the value for the rest of the session
              this.propertiesToRandomize.keys().forEach((propertyToRandomize) => {
                if(modified.properties[propertyToRandomize]) {
                  const originalValue = modified.properties[propertyToRandomize];

                  modified.properties[propertyToRandomize] = this.propertiesToRandomize.get(propertyToRandomize);
                  modified.properties['$current_url'] = modified.properties['$current_url']?.replace(originalValue, this.propertiesToRandomize.get(propertyToRandomize));
                  modified.properties['$path_name'] = modified.properties['$path_name']?.replace(originalValue, this.propertiesToRandomize.get(propertyToRandomize));
                }
              });

              if(modified.event === "$groupidentify" && this.config.groups[modified.properties.$group_type]) {
                modified.properties.$group_key = this.config.groups[modified.properties.$group_type]
                modified.properties.$group_set = {
                  name: this.config.groups[modified.properties.$group_type]
                }
              } else {
                if(modified.properties.$groups) {
                  Object.keys(modified.properties.$groups).forEach((group) => {
                    modified.properties.$groups[group] = this.config.groups[group];
                  });
                }
              }

              if(modified.event === "$set" && modified.properties.$set.email) {
                modified.properties.$set.email = this.config.email
              }



              if(modified.event !== "$identify") {
                allModifiedEvents.push(modified);
              }
            }
          }
        }
      }

      // Debug: show what session IDs we found
      // if (seenSessionIds.size > 0) {
      //   console.log(
      //     `🔍 Found ${seenSessionIds.size} unique session ID(s) in events:`
      //   );
      //   Array.from(seenSessionIds)
      //     .slice(0, 10)
      //     .forEach((id) => {
      //       console.log(`   - ${id}`);
      //     });
      //   if (seenSessionIds.size > 10) {
      //     console.log(`   ... and ${seenSessionIds.size - 10} more`);
      //   }
      // }

      // if (allModifiedEvents.length === 0) {
      //   console.log(
      //     `⚠️  No events found matching session ${originalSessionId}`
      //   );
      //   return null;
      // }

      // add exposure and conversion events if flags are assigned (for experiments)
      if (this.flagAssignments && Object.keys(this.flagAssignments).length > 0) {
        const exposureEvents = this.flagManager.createExposureEvents(
          this.flagAssignments,
          this.config.userId,
          newSessionId,
          this.config.timestamp
        );

        const conversions = this.flagManager.determineConversions(
          this.flagAssignments,
          this.config.userId,
          newSessionId
        );

        const conversionEvents = this.flagManager.createConversionEvents(
          conversions,
          this.flagAssignments,
          this.config.userId,
          newSessionId,
          this.config.timestamp
        );

        // insert exposure events at beginning, conversion events at end
        allModifiedEvents = [...exposureEvents, ...allModifiedEvents, ...conversionEvents];
      }

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
              // console.log(
              //   `🔄 Re-compressed DOM snapshot back to original format`
              // );
            } catch (error) {
              // console.warn(
              //   "Failed to re-compress DOM snapshot:",
              //   error.message
              // );
            }
          }
        });
      }
    });
  }

  async replaySession({ dryRun = true } = {}) {
    // console.log("🎬 Creating new session from captured recording...\n");

    // Load flags and assign to this user
    try {
      await this.flagManager.loadConfig();
      this.flagAssignments = this.flagManager.assignFlags(this.config.userId);
      if (this.flagAssignments && Object.keys(this.flagAssignments).length > 0) {
        console.log(`✅ Assigned ${Object.keys(this.flagAssignments).length} feature flags to user ${this.config.userId}`);
      }
    } catch (error) {
      console.log(`⚠️  No feature flags configured or error loading: ${error.message}`);
      this.flagAssignments = null;
    }

    try {
      // Load recordings
      const recordingsData = await fs.readFile(
        path.join(
          __dirname,
          "data",
          `${this.config.recordingId}-recordings.jsonl`
        ),
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

      for await (const recording of recordings) {
        // Modify and recompress
        const { compressed, identifiers } = await this.modifyAndRecompress(
          recording,
          newSessionIds,
          newWindowIds
        );

          // console.log(`\n✅ New session created successfully!`);
          // console.log(
          //   `📈 Recording Response: HTTP ${recordingResponses
          //     .map((r) => r?.status || "N/A")
          //     .join(", ")}`
          // );
          // console.log(`🔍 Session details:`);
          // console.log(`   Original Session: ${identifiers.originalSessionId}`);
          // console.log(`   New Session:      ${identifiers.newSessionId}`);
        }


        // Find and modify events for this session

      for await (const [
        originalSessionId,
        newSessionId,
      ] of newSessionIds.entries()) {
        const batchData = await this.loadAndModifyEvents(
          originalSessionId,
          newSessionId
        );

        // Send batch if events were found
        if (batchData) {
          console.log('sending')
          await this.sendEventsToPostHog({ batchData, dryRun });
        }
      }

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

export default PostHogSessionReplay;
