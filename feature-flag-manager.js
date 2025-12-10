import fs from "fs/promises";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * FeatureFlagManager handles all feature flag and experiment logic
 * - deterministic bucketing (same user always gets same variant)
 * - event injection ($feature_flag_called events send,  $feature/flag-key properties added to events)
 * - conversion simulation with realistic variance
 */
class FeatureFlagManager {
  constructor(configPath = "./feature-flags.json") {
    this.flags = [];
    this.configPath = configPath;
    this.configLoaded = false;
  }

  // load flags from config
  async loadConfig() {
    if (this.configLoaded) {
      return; // already loaded
    }

    try {
      const configFullPath = path.join(__dirname, this.configPath);
      const configData = await fs.readFile(configFullPath, "utf8");
      const config = JSON.parse(configData);
      this.flags = config.flags || [];
      this.configLoaded = true;
      console.log(`✅ ------------ Loaded ${this.flags.length} feature flags from config`);
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("⚠️  No feature-flags.json found, skipping feature flags");
        this.flags = [];
        this.configLoaded = true;
      } else {
        throw new Error(`Failed to load feature flags config: ${error.message}`);
      }
    }
  }

  // hashing to bucket users
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  // bucket users
  bucketUser(userId, flagKey) {
    const hashInput = `${userId}:${flagKey}`;
    const hash = this.simpleHash(hashInput);
    return hash % 100;
  }

  assignVariant(userId, flag) {
    if (flag.type === "boolean") {
      const bucketValue = this.bucketUser(userId, flag.key);
      return bucketValue < flag.rollout_percentage ? "true" : "false";
    }

    if (flag.type === "experiment") {
      const bucketValue = this.bucketUser(userId, flag.key);

      // accumulate through variants
      let accumulated = 0;
      for (const variant of flag.variants) {
        accumulated += variant.rollout_percentage;
        if (bucketValue < accumulated) {
          return variant.name;
        }
      }

      // fallback to last variant if percentages don't sum to 100
      return flag.variants[flag.variants.length - 1].name;
    }

    // unknown type, default to first variant or "true", this may not be needed idk
    return flag.variants ? flag.variants[0].name : "true";
  }

  assignFlags(userId) {
    const assignments = {};

    for (const flag of this.flags) {
      if (!flag.active) {
        continue; // skip inactive flags, just in case
      }

      const variant = this.assignVariant(userId, flag);
      assignments[flag.key] = variant;
    }

    return assignments;
  }

  getFlagProperties(assignments) {
    const properties = {};
    const activeFlags = [];

    for (const [flagKey, variant] of Object.entries(assignments)) {
      properties[`$feature/${flagKey}`] = variant;
      activeFlags.push(flagKey);
    }

    if (activeFlags.length > 0) {
      properties.$active_feature_flags = activeFlags;
    }

    return properties;
  }

  // create $feature_flag_called events
  createExposureEvents(assignments, userId, sessionId, timestamp) {
    const exposureEvents = [];
    const eventTimestamp = new Date(timestamp).toISOString();

    for (const [flagKey, variant] of Object.entries(assignments)) {
      exposureEvents.push({
        event: "$feature_flag_called",
        distinct_id: userId,
        timestamp: eventTimestamp,
        properties: {
          $session_id: sessionId,
          $feature_flag: flagKey,
          $feature_flag_response: variant,
          $lib: "posthog-session-replay",
          $lib_version: new Date().toISOString(),
        },
      });
    }

    return exposureEvents;
  }

  // add flag properties to events
  injectFlagProperties(event, assignments) {
    if (!event.properties) {
      event.properties = {};
    }

    const flagProperties = this.getFlagProperties(assignments);
    Object.assign(event.properties, flagProperties);

    return event;
  }

  // claude did this, but seems like it works
  shouldConvert(userId, sessionId, variant, flag) {
    const variantConfig = flag.variants.find((v) => v.name === variant);
    if (!variantConfig || !variantConfig.conversion_rate) {
      return false;
    }

    // Create unique seed for this user's conversion decision
    // Using sessionId ensures different sessions can have different outcomes
    const seed = this.simpleHash(`${userId}:${sessionId}:${flag.key}`);

    // Generate pseudo-random value based on seed
    const pseudoRandom = (seed % 10000) / 10000;

    // Add variance using Box-Muller transform for normal distribution
    const variance = variantConfig.conversion_variance || 0;
    const u1 = pseudoRandom;
    const u2 = (seed % 100) / 100;

    // Box-Muller transform to get normal distribution
    const normalVariance =
      Math.sqrt(-2 * Math.log(u1 + 0.0001)) * Math.cos(2 * Math.PI * u2);

    // Calculate actual conversion rate with variance
    const actualConversionRate = Math.max(
      0,
      Math.min(
        1,
        variantConfig.conversion_rate + normalVariance * variance
      )
    );

    // Determine if this session converts
    return pseudoRandom < actualConversionRate;
  }

  determineConversions(assignments, userId, sessionId) {
    const conversions = {};

    for (const [flagKey, variant] of Object.entries(assignments)) {
      const flag = this.flags.find((f) => f.key === flagKey);

      // only process experiments (not boolean flags)
      if (!flag || flag.type !== "experiment") {
        continue;
      }

      // should it convert
      conversions[flagKey] = this.shouldConvert(userId, sessionId, variant, flag);
    }

    return conversions;
  }

  createConversionEvents(conversions, assignments, userId, sessionId, timestamp) {
    const conversionEvents = [];

    for (const [flagKey, shouldConvert] of Object.entries(conversions)) {
      if (!shouldConvert) {
        continue;
      }

      const flag = this.flags.find((f) => f.key === flagKey);
      if (!flag || !flag.conversion_events || flag.conversion_events.length === 0) {
        continue;
      }

      // pick random conversion event from allowed events
      const eventNames = flag.conversion_events;
      const eventIndex = this.simpleHash(`${userId}:${sessionId}:${flagKey}`) % eventNames.length;
      const eventName = eventNames[eventIndex];

      const offsetMs = (this.simpleHash(`${sessionId}:offset`) % (5 * 60 * 1000));
      const eventTimestamp = new Date(timestamp + offsetMs).toISOString();

      conversionEvents.push({
        event: eventName,
        distinct_id: userId,
        timestamp: eventTimestamp,
        properties: {
          $session_id: sessionId,
          $lib: "posthog-session-replay",
          $lib_version: new Date().toISOString(),
          ...this.getFlagProperties(assignments),
        },
      });
    }

    return conversionEvents;
  }
}

export default FeatureFlagManager;
