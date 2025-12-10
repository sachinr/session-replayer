# Feature Flags & Experiments - Usage Guide

## Overview

The session replayer now supports feature flags and experiments! This allows you to:
- Generate realistic A/B test data with statistical variance
- Assign users to experiment variants deterministically (same user always gets same variant)
- Create conversion events with configurable rates
- Send `$feature_flag_called` exposure events
- Add `$feature/flag-key` properties to all events

## Quick Start

### 1. Configure Your Experiment

Edit `feature-flags.json` to define your experiments (or cp feature-flags-example.json feature-flags.json):

```json
{
  "flags": [
    {
      "key": "checkout-experiment",
      "type": "experiment",
      "active": true,
      "description": "Checkout flow A/B test",
      "variants": [
        {
          "name": "control",
          "rollout_percentage": 50,
          "conversion_rate": 0.15,
          "conversion_variance": 0.02
        },
        {
          "name": "variant-a",
          "rollout_percentage": 50,
          "conversion_rate": 0.18,
          "conversion_variance": 0.025
        }
      ],
      "conversion_events": ["checkout_completed", "purchase"],
      "metrics": {
        "type": "trend",
        "event_name": "checkout_completed"
      }
    }
  ]
}
```

### 2. Create Flags and Experiments in PostHog

```bash
node create-flags-and-experiments.js
```

This will process all active flags in `feature-flags.json` and:
- Create the feature flags (boolean or multivariate) in PostHog
- Create experiment entities for any flags with `type: "experiment"`
- Configure metrics tracking

### 3. Run Your Session Replay

```bash
node main.js
```

The feature flags are **automatically applied** - no changes to your workflow!

## What Happens During Replay

When you run `node main.js`, the system now:

1. **Loads feature flags** from `feature-flags.json`
2. **Assigns variants** to each user deterministically (hash-based on user ID)
3. **Injects flag properties** into all events:
   ```json
   {
     "$feature/checkout-experiment": "control",
     "$active_feature_flags": ["checkout-experiment"]
   }
   ```
4. **Creates exposure events** at session start:
   ```json
   {
     "event": "$feature_flag_called",
     "properties": {
       "$feature_flag": "checkout-experiment",
       "$feature_flag_response": "control"
     }
   }
   ```
5. **Generates conversion events** based on configured rates with realistic variance

## Configuration Options

### Flag Types

**Boolean Flag:**
```json
{
  "key": "new-ui",
  "type": "boolean",
  "active": true,
  "rollout_percentage": 50
}
```

**Experiment (A/B Test):**
```json
{
  "key": "pricing-test",
  "type": "experiment",
  "active": true,
  "variants": [
    {"name": "control", "rollout_percentage": 33, "conversion_rate": 0.10, "conversion_variance": 0.01},
    {"name": "price-low", "rollout_percentage": 33, "conversion_rate": 0.15, "conversion_variance": 0.02},
    {"name": "price-high", "rollout_percentage": 34, "conversion_rate": 0.08, "conversion_variance": 0.01}
  ],
  "conversion_events": ["purchase_completed"],
  "metrics": {
    "type": "trend",
    "event_name": "purchase_completed"
  }
}
```

### Variant Configuration

- `name`: Variant identifier (e.g., "control", "variant-a")
- `rollout_percentage`: % of users in this variant (should sum to 100)
- `conversion_rate`: Base conversion rate (0.0 to 1.0)
- `conversion_variance`: Standard deviation for realistic variance

### Metrics Types

**Trend Metric:**
```json
{
  "type": "trend",
  "event_name": "checkout_completed"
}
```

**Funnel Metric:**
```json
{
  "type": "funnel",
  "steps": [
    {"event": "pricing_page_viewed"},
    {"event": "signup_started"},
    {"event": "signup_completed"}
  ]
}
```

## Example Output

When replaying a session, you'll see:

```
🎬 Creating new session from captured recording...

✅ Loaded 1 feature flags from config
✅ Assigned 1 feature flags to user user-123

🔍 Looking for events with session ID: abc-123
✅ Found 15 events for session abc-123
✅ Added 1 exposure events and 1 conversion events

✅ Modified 17 chunks
🚀 Sending session recording to PostHog...
```

## Real-World Example

Let's say you want to test a new checkout flow with realistic data:

**Step 1:** Define the experiment in `feature-flags.json`:
```json
{
  "key": "new-checkout",
  "type": "experiment",
  "active": true,
  "description": "New one-page checkout vs traditional multi-step",
  "variants": [
    {
      "name": "control",
      "rollout_percentage": 50,
      "conversion_rate": 0.12,
      "conversion_variance": 0.02
    },
    {
      "name": "one-page",
      "rollout_percentage": 50,
      "conversion_rate": 0.15,
      "conversion_variance": 0.025
    }
  ],
  "conversion_events": ["purchase_completed"],
  "metrics": {
    "type": "funnel",
    "steps": [
      {"event": "checkout_started"},
      {"event": "payment_info_entered"},
      {"event": "purchase_completed"}
    ]
  }
}
```

**Step 2:** Create in PostHog:
```bash
node create-flags-and-experiments.js
```

**Step 3:** Run your replay:
```bash
node main.js
```

**Step 4:** View results in PostHog:
- Go to Experiments tab
- Find "New one-page checkout vs traditional multi-step"
- See realistic conversion data with statistical variance
- Both variants will have conversions, creating a believable experiment result

## Key Features

### Deterministic Bucketing
- Same user ID always gets same variant across all sessions
- Hash-based algorithm ensures consistent assignment
- Perfect for realistic user journeys

### Realistic Conversion Rates
- Configurable base conversion rate per variant
- Statistical variance creates believable results
- No artificial "perfect winners"

### No Code Changes Required
- Just configure `feature-flags.json`
- Run `node main.js` as usual
- Feature flags automatically applied!

### PostHog API Integration
- Creates multivariate feature flags
- Creates experiment entities
- Configures metrics tracking
- Single command to create all: `node create-flags-and-experiments.js`

## Troubleshooting

### No feature flags applied
- Check that `feature-flags.json` exists
- Verify JSON is valid (`node -e "require('./feature-flags.json')"`)
- Ensure `active: true` on your flags

### Distribution is off
- Check that rollout percentages sum to 100
- Distribution should be within ±5% with 1000+ users
- Verify bucketing is working with dry run output

### Conversions not appearing
- Verify `conversion_events` array is not empty
- Check `conversion_rate` is greater than 0
- Ensure experiment type is "experiment", not "boolean"

## Environment Variables

Required for creating experiments via API:

```bash
POSTHOG_API_KEY=phc_xxx              # Project API key (for event ingestion)
POSTHOG_PERSONAL_API_KEY=phx_xxx     # Personal API key (for creating experiments)
POSTHOG_PROJECT_ID=12345             # Your project ID
```

## Technical Details

### Event Structure

**Exposure Event:**
- Event: `$feature_flag_called`
- Timestamp: Session start
- Properties: `$feature_flag`, `$feature_flag_response`

**Regular Events:**
- Properties: `$feature/flag-key`, `$active_feature_flags`

**Conversion Events:**
- Event: From `conversion_events` array
- Timestamp: Random offset (0-5 minutes into session)
- Properties: Includes all flag properties

### Bucketing Algorithm

```javascript
// Hash user ID + flag key
const hash = simpleHash(`${userId}:${flagKey}`);
const bucket = hash % 100;  // 0-99

// Assign to variant based on rollout percentages
let accumulated = 0;
for (const variant of variants) {
  accumulated += variant.rollout_percentage;
  if (bucket < accumulated) return variant.name;
}
```

### Conversion Decision

```javascript
// Deterministic per-session randomness
const seed = simpleHash(`${userId}:${sessionId}:${flagKey}`);
const random = (seed % 10000) / 10000;

// Add normal distribution variance (Box-Muller transform)
const actualRate = baseRate + (normalVariance * variance);

// Decide if converts
return random < actualRate;
```

## Files

**Created:**
- `feature-flags.json` - Configuration for all flags/experiments
- `feature-flag-manager.js` - Core logic module
- `create-flags-and-experiments.js` - CLI script to create all flags and experiments in PostHog

**Modified:**
- `replay-session.js` - Integrated feature flag logic (no changes to main.js!)

---

For more details, see the implementation plan at `.claude/plans/compiled-munching-feigenbaum.md`.
