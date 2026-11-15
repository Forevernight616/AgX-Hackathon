const BASE = (import.meta.env.VITE_AGENT_API || 'http://localhost:8000').replace(/\/$/, '');
export async function agentHealth() {
  const response = await fetch(`${BASE}/api/health`, {signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
export async function deliberate(state, event = 'operator_review', jobId = null, includeAgronomy = false) {
  const response = await fetch(`${BASE}/api/agents/deliberate`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({event, jobId, includeAgronomy, state: {
      time: state.time, tractors: state.tractors.map(t => ({id:t.id, x:t.x, y:t.y, status:t.status, fuel:t.fuel, speed:t.speed, travelBurn:t.travelBurn, workBurn:t.workBurn, implements:t.implements, capabilities:t.capabilities, jobId:t.jobId})),
      fields: state.fields, jobs: state.jobs
    }})
  });
  if (!response.ok) throw new Error(`Agent API HTTP ${response.status}`);
  return response.json();
}
