# FieldOps — Team-hosted Ollama setup

## Architecture and honest scope

Vue simulator -> FastAPI multi-agent advisory service -> Ollama (on teammate's machine). Fleet, Navigation and Safety agents each make event-triggered Ollama calls; Agronomy is optional. Tractor agents submit **deterministic** proposals and keep per-tractor in-process memories. FastAPI verifies equipment, fuel and estimated deadline before making recommendations. The existing Vue dispatcher remains authoritative and has its own safety validation. AI recommendations are **advisory, not executed**. This is a working integration bridge, not yet an LLM-controlled fleet. Navigation uses straight-line estimates in the backend, while the Vue simulation handles obstacles and pathfinding; never treat AI recommendations as executable routes without rechecking the simulator's route and fuel rules.

## Recommended: teammate runs both Ollama and API

On the teammate's machine:

```bash
ollama pull llama3.2
ollama serve  # only if the Ollama service is not already running
cd fieldops/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env as needed, then load it:
set -a; source .env; set +a
uvicorn main:app --host 0.0.0.0 --port 8000
```

For Windows PowerShell: `py -m venv .venv`, `.venv\\Scripts\\Activate.ps1`, `pip install -r requirements.txt`, then set `$env:OLLAMA_URL='http://127.0.0.1:11434'` and `$env:OLLAMA_MODEL='llama3.2'` before running `uvicorn main:app --host 0.0.0.0 --port 8000`.

On each teammate's computer, copy `.env.example` to `.env` in the **fieldops root** and set:

```
VITE_AGENT_API=http://TEAMMATE_LAN_IP:8000
```

Then `npm install && npm run dev`. The teammate should add your actual Vue origin (e.g. `http://YOUR_LAN_IP:5173`) to `FRONTEND_ORIGINS` in the backend environment, and restart the backend. If you run Vue locally using localhost:5173, the default origin is already allowed. Open the backend URL `/api/health` from your computer to verify reachability.

### Networking / security

Prefer a trusted private LAN or VPN. Allow inbound TCP 8000 on the host firewall only from teammates. **Do not port-forward or publicly expose this prototype API**: it has no authentication, and its LLM endpoint can consume substantial resources. Keep Ollama bound to 127.0.0.1 if FastAPI runs on the same host. If the API runs on a different computer, configure Ollama to listen on a private address (`OLLAMA_HOST`) and restrict access with firewall/VPN. Never expose port 11434 to the public internet.

## How to use

Open FieldOps. Click **Check connection** in the AI Farm Orchestrator strip. Click **Ask agents to review plan** to call the Fleet, Navigation and Safety LLM roles (plus Agronomy if checked). Enable **Ask agents after job submissions and breakdowns** to trigger event-based reasoning. The Event Console shows calls, proposals, and replies. LLM calls do not occur on every tick. The simulator continues working if Ollama is unavailable. Exports include the agent messages.

## Important limitations / next implementation step

- Agent memories are in Python process memory; they reset on backend restart and are shared between clients. Add SQLite with session IDs before multi-user production use.
- Tractor bidding is deterministic, not one LLM call per tractor. This scales better, but label it accurately in the demo.
- Safety Agent LLM explanations cannot override deterministic eligibility or the existing simulator safety checks.
- Recommendations are not applied to the live simulator. To give the LLM control, add a validated `propose -> verify with simulator route/safety -> commit` API, and keep a deterministic fallback.
- AgOpenWeb is not connected; this project uses its own scenario-based world.
