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
- First run is always a dry run (no data sent)
- You'll be prompted to confirm before sending live data

## Project Structure

- `proxy.js` - Proxy server that captures PostHog events and recordings
- `main.js` - Main script for generating and replaying sessions
- `replay-session.js` - Handles replaying individual sessions
- `generation-config.json` - Configuration for personas, sessions, and user behavior
- `data/` - Directory containing recorded events and session recordings (JSONL format)

## Configuration

Edit `generation-config.json` to customize:

- Date range for data generation
- Starting user count and DAU percentage
- Daily signups growth rate
- Personas with their user share, churn rate, and associated session recordings
