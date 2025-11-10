// read generation-config.json
import config from "./generation-config.json" with { type: "json" };
import ReplaySession from "./replay-session.js";

const generateUsers = async (count, startId = 0) => {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push({
      id: `user-${startId + i}`,
      name: `User ${startId + i}`,
      email: `user-${startId + i}@example.com`,
      churned: false,
      session_count: 0,
      persona: (() => {
        // Weighted selection based on user_share
        const r = Math.random();
        let acc = 0;
        for (let j = 0; j < config.personas.length; j++) {
          acc += config.personas[j].user_share;
          if (r < acc) return config.personas[j].name;
        }
        // fallback (shouldn't happen if shares sum to 1)
        return config.personas[config.personas.length - 1].name;
      })(),
    });
  }
  return users;
};

const getWeekdayOrWeekendDAU = (date, dau) => {
    // If the day is Saturday (6) or Sunday (0), reduce DAU to ~10% of target with ±5% random variance
    let isWeekend = date.getDay() === 0 || date.getDay() === 6;
    let weekendVariance = 0.1 + (Math.random() * 0.1 - 0.05); // 0.05 to 0.15
    let weekendDau = isWeekend && Math.max(1, Math.round(dau * weekendVariance));
    return weekendDau || dau;
}

const dailySignups = async (currentTotalUsers) => {
    // Add new users with variance: positive swings can be large, negative small
    // Negative variance up to -5%, positive up to +30%
    const variance = (Math.random() < 0.7) ? Math.random() * 0.005 : -(Math.random() * 0.01);
    const signupCount = Math.ceil(currentTotalUsers * (config.daily_signups_growth + variance));
    console.log(`Signups for the day (with variance): ${signupCount}`);

    return generateUsers(signupCount, currentTotalUsers);
}

const replaySession = async (recordingId, userId, sessionId, timestamp, dryRun) => {
  console.log(`Replaying session ${sessionId} for user ${userId} with recording ${recordingId} at ${timestamp}`);
  const replaySession = new ReplaySession({
    recordingId,
    userId,
    sessionId,
    timestamp,
  });
  await replaySession.replaySession({ dryRun });
}

const run = async ({ dryRun = true } = {}) => {
  const users = await generateUsers(config.starting_user_count);
  const startDate = new Date(config.start_date);
  const endDate = new Date(config.end_date);
  let dau = config.starting_user_count * config.dau_percentage;

  // generate sessions for each day
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    let dailyUserCount = 0;
    const dauLimit = getWeekdayOrWeekendDAU(d, dau);

    while (dailyUserCount < dauLimit) {
      const user = users[Math.floor(Math.random() * users.length)];
      if (!user.churned) {
        const persona = config.personas.find(p => p.name === user.persona);
        const sessionsToGenerate = Math.ceil(Math.random() * persona.sessions.length);

        const firstSessionIndex = user.session_count === 0 || persona.sessions.length === 1 ? 0 : 1

        for(let i = firstSessionIndex; i < Math.min(persona.sessions.length, sessionsToGenerate); i++) {
          const recordingId = persona.sessions[i].id;
          const sessionId = crypto.randomUUID();

          await replaySession(recordingId, user.id, sessionId, d.getTime() + (dailyUserCount * 1000 * 60) + (i * 1000 * 60), dryRun);
          console.log(`User ${user.id} generated session ${i} with recording ${recordingId}`);
        }

        user.session_count++;
        user.churned = Math.random() < config.personas.find(p => p.name === user.persona).churn_rate;
        if(user.churned) {
          console.log(`User ${user.id} churned after ${user.session_count} sessions`);
        }

        dailyUserCount++;
      }
      // Await a Promise to yield to the event loop for async simulation
      await Promise.resolve();
    }

    users.push(...(await dailySignups(users.length)));
    dau = Math.ceil(users.filter(u => !u.churned).length * config.dau_percentage);

    console.log(`Total active users: ${users.filter(u => !u.churned).length}`);
    console.log(`DAU: ${dau}`);
  }
};


import readline from "readline";

const askQuestion = (question) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
};

const cliEntry = async () => {
  console.log("INFO: The first run will ALWAYS be a dry run (no data will be sent).");
  console.log("INFO: After seeing the dry run output, you may confirm a LIVE run.\n");

  // First: always do dry run
  await run({ dryRun: true });

  // Ask for confirmation
  let answer = await askQuestion('\nDo you want to perform a LIVE run and send data? Type "Y" (capital Y) and press Enter to continue: ');
  if (answer === "Y") {
    await run({ dryRun: false });
  } else {
    console.log("LIVE run cancelled. No data has been sent.");
  }
};

// Call the CLI wrapper instead of raw run
cliEntry();
