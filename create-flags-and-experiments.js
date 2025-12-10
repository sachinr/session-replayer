import dotenv from "dotenv";
import https from "https";
import fs from "fs/promises";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// create ff and experiments defined in feature-flags.json
async function loadFeatureFlagsConfig() {
  try {
    const configPath = path.join(__dirname, "feature-flags.json");
    const configData = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(configData);
    return config.flags || [];
  } catch (error) {
    throw new Error(`Failed to load feature-flags.json: ${error.message}`);
  }
}

async function createFeatureFlag(flagData, config) {
  const {
    personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY,
    projectId = process.env.POSTHOG_PROJECT_ID,
    host = process.env.POSTHOG_HOST || "app.posthog.com",
  } = config;

  const requestData = JSON.stringify(flagData);
  const options = {
    hostname: host,
    port: 443,
    path: `/api/projects/${projectId}/feature_flags/`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${personalApiKey}`,
      "Content-Length": requestData.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
        }
      });
    });
    req.on("error", reject);
    req.write(requestData);
    req.end();
  });
}

async function createExperiment(experimentData, config) {
  const {
    personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY,
    projectId = process.env.POSTHOG_PROJECT_ID,
    host = process.env.POSTHOG_HOST || "app.posthog.com",
  } = config;

  const requestData = JSON.stringify(experimentData);
  const options = {
    hostname: host,
    port: 443,
    path: `/api/projects/${projectId}/experiments/`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${personalApiKey}`,
      "Content-Length": requestData.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${responseBody}`));
        }
      });
    });
    req.on("error", reject);
    req.write(requestData);
    req.end();
  });
}

async function checkIfFlagExists(key, config) {
  const {
    personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY,
    projectId = process.env.POSTHOG_PROJECT_ID,
    host = process.env.POSTHOG_HOST || "app.posthog.com",
  } = config;

  return new Promise((resolve) => {
    const options = {
      hostname: host,
      port: 443,
      path: `/api/projects/${projectId}/feature_flags/?key=${key}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${personalApiKey}`,
      },
    };

    const req = https.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(responseBody);
            const existingFlag = data.results?.find(f => f.key === key);
            resolve(existingFlag || null);
          } catch (error) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function createFlagAndExperiment(flagDef, config) {
  const { key, type, description, variants, conversion_events, metrics } = flagDef;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📝 Processing: ${description || key}`);
  console.log(`   Key: ${key}`);
  console.log(`   Type: ${type}`);

  // check if flag already exists and don't blow up
  const existingFlag = await checkIfFlagExists(key, config);

  let flagResponse;
  if (existingFlag) {
    const isMultivariate = existingFlag.filters?.multivariate?.variants?.length > 0;

    if (type === "experiment" && !isMultivariate) {
      console.log(`   ⚠️  Flag exists but is not multivariate - skipping`);
      console.log(`   ℹ️  Delete flag "${key}" in PostHog to recreate as experiment`);
      return { success: false, reason: 'non-multivariate' };
    }

    console.log(`   ✅ Flag already exists (ID: ${existingFlag.id})`);
    flagResponse = existingFlag;
  } else {
    // create flag based on type from feature-flags.json
    if (type === "boolean") {
      console.log(`   📌 Creating boolean flag...`);
      const flagData = {
        key,
        name: description || key,
        description: description || "",
        active: true,
        filters: {
          groups: [{
            properties: [],
            rollout_percentage: flagDef.rollout_percentage || 100
          }]
        }
      };

      flagResponse = await createFeatureFlag(flagData, config);
      console.log(`   ✅ Boolean flag created (ID: ${flagResponse.id})`);
    } else if (type === "experiment") {
      console.log(`   📌 Creating multivariate flag...`);
      const flagData = {
        key,
        name: description || key,
        description: description || "",
        active: true,
        filters: {
          groups: [{
            properties: [],
            rollout_percentage: 100
          }],
          multivariate: {
            variants: variants.map(v => ({
              key: v.name,
              name: v.name,
              rollout_percentage: v.rollout_percentage
            }))
          }
        }
      };

      flagResponse = await createFeatureFlag(flagData, config);
      console.log(`   ✅ Multivariate flag created (ID: ${flagResponse.id})`);
    }
  }

  // create experiment if that's what we're doing
  if (type === "experiment") {
    console.log(`   📊 Creating experiment...`);

    const experimentData = {
      name: description || key,
      description: description || "",
      feature_flag_key: key,
      feature_flag: flagResponse.id,
      start_date: new Date().toISOString(),
      filters: {},
      parameters: {
        feature_flag_variants: variants.map(v => ({
          key: v.name,
          rollout_percentage: v.rollout_percentage
        })),
        recommended_running_time: 14,
        minimum_detectable_effect: 5
      }
    };

    // add metrics for exp
    if (metrics?.type === "trend") {
      experimentData.metrics = [{
        type: "primary",
        metric_type: "trend",
        event: {
          id: metrics.event_name,
          name: metrics.event_name,
          type: "events"
        }
      }];
    } else if (metrics?.type === "funnel") {
      experimentData.metrics = [{
        type: "primary",
        metric_type: "funnel",
        funnel: {
          steps: metrics.steps.map((step, idx) => ({
            id: step.event,
            order: idx,
            event: step.event
          }))
        }
      }];
    }

    try {
      const experimentResponse = await createExperiment(experimentData, config);
      console.log(`   ✅ Experiment created (ID: ${experimentResponse.id})`);
      return { success: true, flag: flagResponse, experiment: experimentResponse };
    } catch (error) {
      if (error.message.includes("already exists")) {
        console.log(`   ℹ️  Experiment already exists`);
        return { success: true, flag: flagResponse, experiment: null };
      }
      throw error;
    }
  }

  return { success: true, flag: flagResponse, experiment: null };
}

async function main() {
  console.log("\n🎯 Creating All Feature Flags & Experiments");
  console.log("=".repeat(60));

  if (!process.env.POSTHOG_PERSONAL_API_KEY) {
    console.error("\n❌ Error: POSTHOG_PERSONAL_API_KEY environment variable is required");
    console.log("\nSet it in your .env file:");
    console.log("  POSTHOG_PERSONAL_API_KEY=phx_...\n");
    process.exit(1);
  }

  if (!process.env.POSTHOG_PROJECT_ID) {
    console.error("\n❌ Error: POSTHOG_PROJECT_ID environment variable is required");
    console.log("\nSet it in your .env file:");
    console.log("  POSTHOG_PROJECT_ID=12345\n");
    process.exit(1);
  }

  const config = {
    personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
    projectId: process.env.POSTHOG_PROJECT_ID,
    host: process.env.POSTHOG_HOST || "app.posthog.com",
  };

  // load flags from feature-flags.json
  let flags;
  try {
    flags = await loadFeatureFlagsConfig();
  } catch (error) {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
  }

  if (flags.length === 0) {
    console.log("\n⚠️  No flags found in feature-flags.json\n");
    process.exit(0);
  }

  console.log(`\n📋 Found ${flags.length} flag(s) in feature-flags.json\n`);

  const results = {
    success: 0,
    skipped: 0,
    failed: 0,
  };

  for (const flagDef of flags) {
    if (!flagDef.active) {
      console.log(`\n⏭️  Skipping inactive flag: ${flagDef.key}`);
      results.skipped++;
      continue;
    }

    try {
      const result = await createFlagAndExperiment(flagDef, config);
      if (result.success) {
        results.success++;
      } else {
        results.skipped++;
      }
    } catch (error) {
      console.log(`   ❌ Failed: ${error.message}`);
      results.failed++;
    }
  }

  // summary
  console.log(`\n${'='.repeat(60)}`);
  console.log("\n📊 Summary:");
  console.log(`   ✅ Created/Updated: ${results.success}`);
  console.log(`   ⏭️  Skipped: ${results.skipped}`);
  console.log(`   ❌ Failed: ${results.failed}`);
  console.log("\n✅ Done! Your flags and experiments are ready in PostHog.\n");
}

main().catch((error) => {
  console.error(`\n❌ Unexpected error: ${error.message}\n`);
  process.exit(1);
});
