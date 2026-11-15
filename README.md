# FieldOps — Autonomous Farm Fleet Simulator

A Vue 3 + Vite hackathon starter for **Run the Fleet**. Uses **our own simulation**, not AgOpenWeb. No Conda, Poetry, .NET, backend, or database is required to run this version.

## Start

```bash
cd fieldops
npm install
npm run dev
```

Open the local URL printed by Vite (usually `http://localhost:5173`). For a production build: `npm run build`.

## Demo script

1. Start the simulation and watch jobs dispatch to compatible tractors.
2. Select Atlas 01 in the hierarchy, then click **Trigger breakdown**. Its unfinished job remains pending with its progress preserved; other compatible tractors pick it up when available.
3. Click **Repair tractor** to return it to service.
4. Select **Block route**, click a road cell, and observe route recalculation. Click the same cell to reopen it. (Do not click a tractor or field center.)
5. Select a job and change its priority, or create a new job with **New job**.
6. Open **Analytics** and click **Run fair comparison**. Both algorithms run the same initial scenario and an identical T1 breakdown at simulation minute 12.
7. Export the event log and scenario from the console.

## Structure

- `src/data/scenario.json` — tractors, fields, jobs, grid and obstacles.
- `src/engine/core.js` — state, BFS navigation, deterministic dispatch, tick loop, breakdown recovery, metrics, benchmark.
- `src/App.vue` — Vue dashboard and interactive SVG farm map.
- `src/style.css` — dark simulation-studio interface.

## Algorithm

The smart dispatcher scores compatible, fueled, reachable tractor-job pairs using deadline feasibility, priority, distance, and estimated finish. It greedily assigns the best pair and repeats. FIFO assigns pending jobs in submission order to the first eligible tractor. Both enforce equipment and fuel requirements and avoid simultaneous duplicate job assignments.

## Modeling assumptions and limitations

- Each simulation tick represents **one minute**; travel is one grid cell per tick, and work is incremented per tick.
- Fuel is a simplified percent-like resource; jobs require an estimated fuel reserve. Refueling is not yet implemented.
- Fields are modeled as a single destination cell at their center; no real agricultural physics or machinery control.
- Breakdown recovery preserves fractional job progress. If all compatible tractors are busy, work remains pending until one becomes idle. The app never claims a job has been recovered when it cannot be reassigned.
- Deadline feasibility is checked when dispatching, but late jobs may still be assigned; late completion is counted in metrics. Jobs are not automatically canceled at deadlines.
- Navigation uses shortest path on a grid with four-direction movement. Fields do not obstruct travel. The map is schematic.
- The benchmark uses a fixed T1 breakdown at t=12 and a fixed 180-minute horizon; it does not include live interactive changes made to the current session.
- Travel and idle time are totals across all tractors. A broken tractor is not counted as idle.
- For a production-quality coordinator, add a stronger global optimizer, refueling logic, richer safety checks, replayable event scenarios, and automated tests.

## Hackathon hand-in

Include the GitHub repo URL, this README, `src/data/scenario.json`, exported `fieldops-event-log.json`, and the metrics from the Analytics tab. Run the demo once before exporting your log.

## Version 0.2 features and definitions

- The **Inspector / Analytics** panel is stacked **above Scene Explorer on the left**. Click a tractor or job to inspect it, edit an idle tractor or pending job, or see the assignment explanation.
- Use **+ Tractor** in Scene Explorer to add a tractor. Use **New job** to submit a job. Use **Load JSON** to load a custom scenario. Export the current scenario or event log from the console.
- The bundled scenario has a repeatable breakdown event at simulation minute 12. Scripted events are in `events` with `time`, `type`, and fields such as `tractorId`, `x`, `y`, or `jobId`.
- **On-time completed jobs** count only jobs finished at or before the deadline. **Travel time** is accumulated actual movement time across tractors; **idle time** is available/idle tractor-minutes. Both dispatchers use the same scenario and scripted events.
- The safety gate rejects incompatible equipment, insufficient fuel for the entire trip and remaining work, impossible deadlines, broken tractors, and duplicate job assignments. If a job cannot meet its deadline it stays queued and the operator receives a warning when its deadline passes.
- Routes use Euclidean straight-line travel when clear, and a grid detour when a route is blocked. This is a simplified simulation, not real-world guidance software.
- Refueling is a **manual, simplified stretch feature** for idle tractors. It does not simulate travel to the station. Do not present it as automated fuel-aware routing.
- Changing priority affects pending jobs; already running jobs are not preempted. The benchmark measures the algorithms rather than guaranteeing the smart one wins every metric.

### Testing the coordinator without the frontend

`node --test tests/engine.test.mjs` (Node.js 22+).

## Multi-agent communication (v0.3)

Smart mode now uses an event-driven contract-net-style dispatcher. The orchestrator announces a job (`CALL_FOR_PROPOSALS`), eligible tractor agents evaluate the job, a tractor sends a `PROPOSAL`, and the orchestrator issues an `AWARD`. When a tractor breaks, it sends a `HANDOFF` with the job's retained progress; when a job completes, the tractor sends `COMPLETED`. Filter the event console to **Agent messages** to watch the conversation. Exported logs include structured `messages`, per-tractor `agentMemory`, and `agentStats`.

**Important:** This is a deterministic multi-agent prototype, not an LLM-integrated application. Agent bids are calculated from constraints and travel estimates, and no external AI provider is called. To introduce genuine LLM agents, implement a backend adapter that receives agent events and returns structured, safety-validated proposals. Keep safety, deadlines, fuel, and uniqueness enforced in deterministic code. Never put provider API keys in the browser.

The farm simulation is custom and is **not connected to AgOpenGPS/AgOpenWeb**. This is permitted by the published challenge description. Tractors are loaded dynamically from scenario JSON and can be added in the UI; there is no fixed three-tractor limit. Scaling to 40 tractors may need auction batching and message aggregation to avoid an excessively noisy log.

## Team-hosted Ollama integration (v0.4)

See [TEAM_OLLAMA_SETUP.md](TEAM_OLLAMA_SETUP.md) for teammate-hosted Ollama, FastAPI, frontend configuration, networking, and limitations. The new AI Farm Orchestrator panel offers real local LLM advice via Fleet, Navigation, Safety and optional Agronomy roles. This is **advisory integration**, not autonomous execution of LLM assignments; the existing deterministic simulator remains in control.


## Team Ollama handoff
See [DUC_HANDOFF.md](DUC_HANDOFF.md). The backend defaults to `AI_MODE=mock` so the frontend can be tested without an LLM.
