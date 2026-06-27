/**
 * Demo traffic generator. Sends a steady trickle from several "normal" IPs and a
 * hard burst from one "attacker" IP, so the dashboard visibly throttles one key.
 *
 * Uses X-Forwarded-For to vary the client IP (the server runs with trustProxy),
 * so each fake IP gets its own bucket.
 *
 * Run the server first, then: `npm run demo:traffic`
 * Open the dashboard at the server root, e.g. http://localhost:3000
 */
const TARGET = process.env.TARGET || 'http://localhost:3000/api/ping';
const NORMAL = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '203.0.113.7', '198.51.100.4'];
const ATTACKER = '45.155.205.99';

async function hit(ip) {
  try {
    await fetch(TARGET, { headers: { 'X-Forwarded-For': ip } });
  } catch {
    /* server not up yet — ignore */
  }
}

// Steady, well-behaved traffic.
setInterval(() => {
  for (const ip of NORMAL) hit(ip);
}, 200);

// One IP hammering — this is what gets throttled.
setInterval(() => {
  for (let i = 0; i < 60; i++) hit(ATTACKER);
}, 1000);

const dashboardUrl = TARGET.replace(/\/api\/ping\/?$/, '') || TARGET;
// eslint-disable-next-line no-console
console.log(`generating traffic against ${TARGET}\nopen the dashboard: ${dashboardUrl}`);
