# Session Replayer

A tool for recording and replaying PostHog session recordings to generate realistic demo data.

## Setup

1. **Set up a PostHog project with session replay**

   - Create a PostHog project and enable session replay
   - Note your PostHog project API key

2. **Configure environment variables**

   - Create a `.env` file in the project root
   - Add your PostHog project API key:
     ```
     POSTHOG_API_KEY=your_posthog_project_key_here
     ```
   - If you want to create feature flags and experiments, also add:
     ```
     POSTHOG_PERSONAL_API_KEY=phx_your_personal_api_key_here
     POSTHOG_PROJECT_ID=your_project_id_here
     POSTHOG_HOST=app.posthog.com
     ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Configure your demo app**

   - Point your demo app's PostHog configuration to use the proxy for the `api_url`:
     ```
     api_url: http://localhost:3001
     ```
   - This ensures all PostHog events and session recordings are captured by the proxy

5. **Copy the generation config**
   ```bash
   cp generation-config.example.json generation-config.json
   ```
   - Edit `generation-config.json` to configure your personas, sessions, and user behavior patterns

6. **Configure feature flags (optional)**
   - Edit `feature-flags.json` to define your feature flags and experiments
   - See `FEATURE_FLAGS_USAGE.md` for detailed configuration guide
   - Run `node create-flags-and-experiments.js` to create them in PostHog

## Usage

### Recording Behaviors

For each behavior you want to record:

1. **Start the proxy with a behavior name**

   ```bash
   npm run proxy -- --name [behaviour]
   ```

   For example:

   ```bash
   npm run proxy -- --name signin
   ```

2. **Record yourself performing the behavior**

   - With the proxy running, interact with your demo app
   - The proxy will capture all events and session recordings
   - Data will be saved to `data/[behaviour]-events.jsonl` and `data/[behaviour]-recordings.jsonl`

3. **Stop the proxy** when you're done recording (Ctrl+C)

### Replaying Sessions

After recording behaviors, generate realistic demo data:

```bash
node main.js
```

This will:

- Read your `generation-config.json` configuration
- Replay the recorded sessions according to your persona definitions
- Generate users and sessions over the specified date range
- Apply feature flags and experiments to events (if configured)
- First run is always a dry run (no data sent)
- You'll be prompted to confirm before sending live data

### Feature Flags and Experiments

To add feature flags and experiments to your replayed sessions
cp feature-flags-example.json feature-flags.json

1. **Define flags in `feature-flags.json`**
   ```json
   {
     "flags": [
       {
         "key": "my-experiment",
         "type": "experiment",
         "active": true,
         "description": "My A/B test",
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
             "conversion_variance": 0.02
           }
         ],
         "conversion_events": ["signup_completed"],
         "metrics": {
           "type": "trend",
           "event_name": "signup_completed"
         }
       }
     ]
   }
   ```

2. **Create flags in PostHog**
   ```bash
   node create-flags-and-experiments.js
   ```

3. **Replay sessions** - Feature flags will automatically be applied to all replayed events

Features:
- Deterministic bucketing (same user always gets same variant)
- Realistic conversion distribution with statistical variance
- Automatic `$feature_flag_called` exposure events
- `$feature/flag-key` properties added to all events

## Project Structure

### Core Files
- `proxy.js` - Proxy server that captures PostHog events and recordings
- `main.js` - Main script for generating and replaying sessions
- `replay-session.js` - Handles replaying individual sessions with feature flag integration
- `generation-config.json` - Configuration for personas, sessions, and user behavior
- `data/` - Directory containing recorded events and session recordings (JSONL format)

### Feature Flags
- `feature-flags.json` - Feature flag and experiment definitions
- `feature-flag-manager.js` - Core logic for bucketing, conversions, and event injection
- `create-flags-and-experiments.js` - Script to create flags and experiments in PostHog

### Documentation
- `RECORDING_GUIDE.md` - Guide for recording events using the demo page
- `FEATURE_FLAGS_USAGE.md` - Detailed guide for configuring feature flags

## Configuration

Edit `generation-config.json` to customize:

- Date range for data generation
- Starting user count and DAU percentage
- Daily signups growth rate
- Personas with their user share, churn rate, and associated session recordings
