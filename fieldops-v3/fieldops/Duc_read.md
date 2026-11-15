# FieldOps — Duc / local Ollama handoff

## What is ready
- Vue simulator, dashboard, scenario JSON, coordinator and safety logic.
- FastAPI endpoints: `GET /api/health`, `POST /api/agents/deliberate`, `GET /api/agents/memory`.
- **Mock mode** works without Ollama; the UI can show agent messages while integration is being configured.
- **Ollama mode** uses the local Ollama HTTP API. Agent advice is **advisory only**; the simulator's deterministic scheduler executes jobs. Do not describe this as autonomous LLM control until wired and tested.

## Quick start: single computer

Terminal A (backend):

```bash
cd fieldops/backend
python3 -m venv .venv
source .venv/bin/activate  # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env  # On Windows, copy the file manually or use Copy-Item
uvicorn main:app --host 127.0.0.1 --port 8000
```

Terminal B (frontend):

```bash
cd fieldops
cp .env.example .env
npm install
npm run dev
```

Open http://localhost:5173, use **Check connection**, then **Ask agents to review plan**. In mock mode health reports `ollama: mock` (the UI may label this as offline; backend is still reachable).

## Duc: turn on real Ollama

```bash
ollama pull llama3.2
ollama serve  # only if Ollama is not already running as a service
```

Edit `backend/.env`:

```env
AI_MODE=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2
FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

Restart the backend. Verify `curl http://127.0.0.1:11434/api/tags` and `curl http://127.0.0.1:8000/api/health`.

## Two computers on a trusted LAN / VPN

Recommended: Duc runs **both FastAPI and Ollama** on his machine. Bind FastAPI with `--host 0.0.0.0`, restrict access with a firewall/VPN, and add the **exact frontend origin** (e.g. `http://192.168.1.50:5173`) to `FRONTEND_ORIGINS` in `backend/.env`. Other developers set `VITE_AGENT_API=http://DUC_PRIVATE_IP:8000` in their **frontend root** `.env` and restart Vite. Keep Ollama bound to loopback; do not expose port 11434 to the internet. The FastAPI example has no authentication: use only on a trusted network, never expose it publicly.

## API contract

`POST /api/agents/deliberate` request:

```json
{"event":"operator_review","jobId":null,"includeAgronomy":false,"state":{"time":0,"tractors":[],"fields":[],"jobs":[]}}
```

Response keys: `event`, `time`, `proposals`, `recommended`, `messages`, `advice`, `errors`, `mode`, `memoryCounts`. `messages` entries have `from`, `to`, `kind`, `detail`. The Vue UI expects this shape. Keep it stable when replacing mock/advisory behavior.

## Where to implement actual agent control

- `backend/agents.py`: `ask_model`, `eligible`, `deliberate` (LLM role prompts, memory, proposal generation).
- `backend/main.py`: API and mode selection.
- `src/agentApi.js`: frontend HTTP client.
- `src/App.vue`: `askAI` displays advice/messages; **does not apply recommended assignments**.
- `src/engine/core.js`: deterministic coordinator, simulation, constraints, breakdown recovery.

**Next integration task:** have LLM tractor agents produce *structured proposals*; validate every proposal in the authoritative simulator; commit only valid plans; record acceptance/rejection, timeouts and fallbacks. Never treat free-text LLM output as an executable command. Persistent memory is not implemented; current backend memory is in RAM and resets on restart.

## Tests

```bash
cd fieldops
node --test tests/engine.test.mjs
cd backend
python -m unittest test_agents.py
```

## GitHub

Commit the `fieldops/` directory to the shared repository. Commit `.env.example` files, **not** `.env`, `.venv`, `node_modules`, or any secrets. Duc can clone the repo and follow this guide.
