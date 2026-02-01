import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'golf-intel',
  version: '1.0.0',
  description: 'Real-time golf data from PGA Tour and LPGA - leaderboards, scores, schedules, and player stats.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === Helper: Fetch JSON with error handling ===
async function fetchJSON(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'golf-intel-agent/1.0' }
  });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// ESPN API base
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/golf';

// === FREE ENDPOINT: Leaderboard Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - current PGA Tour leaderboard (top 10 players)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const data = await fetchJSON(`${ESPN_BASE}/pga/events`);
    const event = data.events?.[0];
    if (!event) {
      return { output: { message: 'No active tournament', fetchedAt: new Date().toISOString() } };
    }
    const competitors = event.competitors?.slice(0, 10) || [];
    return {
      output: {
        tournament: event.name,
        status: event.fullStatus?.type?.description || 'Unknown',
        round: event.fullStatus?.displayPeriod || 'N/A',
        leaderboard: competitors.map((c: any, i: number) => ({
          position: i + 1,
          name: c.displayName,
          score: c.score,
          country: c.shortName?.split('.')[0] || 'N/A'
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'ESPN Golf API (live)'
      }
    };
  },
});

// === PAID ENDPOINT 1: Full Tournament Leaderboard ($0.001) ===
addEntrypoint({
  key: 'pga-leaderboard',
  description: 'Full PGA Tour tournament leaderboard with all players',
  input: z.object({
    limit: z.number().optional().default(50).describe('Number of players to return')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const eventsData = await fetchJSON(`${ESPN_BASE}/pga/events`);
    const event = eventsData.events?.[0];
    if (!event) {
      return { output: { error: 'No active PGA tournament' } };
    }
    
    // Get detailed scoreboard for the current event
    const scoreboard = await fetchJSON(`${ESPN_BASE}/pga/scoreboard?event=${event.id}`);
    const competitors = scoreboard.events?.[0]?.competitions?.[0]?.competitors || [];
    
    return {
      output: {
        tournament: {
          id: event.id,
          name: event.name,
          status: event.fullStatus?.type?.description,
          round: event.fullStatus?.displayPeriod,
          date: event.date
        },
        leaderboard: competitors.slice(0, ctx.input.limit).map((c: any, i: number) => ({
          position: i + 1,
          playerId: c.id,
          name: c.athlete?.displayName || c.displayName,
          score: c.score,
          country: c.athlete?.flag?.alt || 'Unknown',
          thru: c.status?.thru || 'F'
        })),
        totalPlayers: competitors.length,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2: Player Scorecard ($0.002) ===
addEntrypoint({
  key: 'player-scorecard',
  description: 'Get detailed hole-by-hole scores for a specific player in current tournament',
  input: z.object({
    playerId: z.string().describe('ESPN player ID (e.g., "569" for Justin Rose)')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const eventsData = await fetchJSON(`${ESPN_BASE}/pga/events`);
    const event = eventsData.events?.[0];
    if (!event) {
      return { output: { error: 'No active tournament' } };
    }
    
    const scoreboard = await fetchJSON(`${ESPN_BASE}/pga/scoreboard?event=${event.id}`);
    const competitors = scoreboard.events?.[0]?.competitions?.[0]?.competitors || [];
    const player = competitors.find((c: any) => c.id === ctx.input.playerId);
    
    if (!player) {
      return { output: { error: 'Player not found in current tournament', availablePlayers: competitors.slice(0, 10).map((c: any) => ({ id: c.id, name: c.athlete?.displayName })) } };
    }
    
    const rounds = player.linescores || [];
    return {
      output: {
        tournament: event.name,
        player: {
          id: player.id,
          name: player.athlete?.displayName || player.displayName,
          country: player.athlete?.flag?.alt || 'Unknown',
          totalScore: player.score
        },
        rounds: rounds.map((round: any, i: number) => ({
          round: i + 1,
          score: round.displayValue,
          holes: round.linescores?.map((h: any) => ({
            hole: h.period,
            strokes: h.value,
            toPar: h.scoreType?.displayValue
          })) || []
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3: PGA Schedule ($0.002) ===
addEntrypoint({
  key: 'pga-schedule',
  description: 'Upcoming PGA Tour tournament schedule',
  input: z.object({
    limit: z.number().optional().default(10).describe('Number of upcoming events')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/pga/scoreboard`);
    const calendar = data.leagues?.[0]?.calendar || [];
    
    const upcoming = calendar.slice(0, ctx.input.limit).map((event: any) => ({
      id: event.id,
      name: event.label,
      startDate: event.startDate,
      endDate: event.endDate
    }));
    
    return {
      output: {
        season: data.leagues?.[0]?.season?.displayName,
        events: upcoming,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4: LPGA Leaderboard ($0.003) ===
addEntrypoint({
  key: 'lpga-leaderboard',
  description: 'Current LPGA Tour leaderboard',
  input: z.object({
    limit: z.number().optional().default(30).describe('Number of players')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const data = await fetchJSON(`${ESPN_BASE}/lpga/events`);
    const event = data.events?.[0];
    if (!event) {
      return { output: { error: 'No active LPGA tournament' } };
    }
    
    const competitors = event.competitors?.slice(0, ctx.input.limit) || [];
    return {
      output: {
        tournament: {
          id: event.id,
          name: event.name,
          status: event.fullStatus?.type?.description,
          round: event.fullStatus?.displayPeriod,
          date: event.date
        },
        leaderboard: competitors.map((c: any, i: number) => ({
          position: i + 1,
          name: c.displayName,
          score: c.score,
          country: c.logo?.includes('/countries/') ? c.logo.split('/countries/500/')[1]?.replace('.png', '').toUpperCase() : 'N/A'
        })),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5: Full Golf Report ($0.005) ===
addEntrypoint({
  key: 'full-report',
  description: 'Comprehensive report: PGA + LPGA leaderboards and upcoming schedule',
  input: z.object({}),
  price: { amount: 5000 },
  handler: async () => {
    const [pgaEvents, lpgaEvents, pgaScoreboard] = await Promise.all([
      fetchJSON(`${ESPN_BASE}/pga/events`),
      fetchJSON(`${ESPN_BASE}/lpga/events`),
      fetchJSON(`${ESPN_BASE}/pga/scoreboard`)
    ]);
    
    const pgaEvent = pgaEvents.events?.[0];
    const lpgaEvent = lpgaEvents.events?.[0];
    const schedule = pgaScoreboard.leagues?.[0]?.calendar?.slice(0, 5) || [];
    
    return {
      output: {
        pga: pgaEvent ? {
          tournament: pgaEvent.name,
          status: pgaEvent.fullStatus?.type?.description,
          round: pgaEvent.fullStatus?.displayPeriod,
          topPlayers: pgaEvent.competitors?.slice(0, 10).map((c: any, i: number) => ({
            position: i + 1,
            name: c.displayName,
            score: c.score
          })) || []
        } : null,
        lpga: lpgaEvent ? {
          tournament: lpgaEvent.name,
          status: lpgaEvent.fullStatus?.type?.description,
          round: lpgaEvent.fullStatus?.displayPeriod,
          topPlayers: lpgaEvent.competitors?.slice(0, 10).map((c: any, i: number) => ({
            position: i + 1,
            name: c.displayName,
            score: c.score
          })) || []
        } : null,
        upcomingPGA: schedule.map((e: any) => ({
          name: e.label,
          startDate: e.startDate
        })),
        generatedAt: new Date().toISOString()
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const fs = await import('fs');
    const icon = fs.readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// ERC-8004 registration file
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.BASE_URL || 'https://golf-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "golf-intel",
    description: "Real-time golf data: PGA and LPGA leaderboards, player scorecards, tournament schedules. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Golf Intel agent running on port ${port}`);

export default { port, fetch: app.fetch };
