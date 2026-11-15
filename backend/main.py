from dotenv import load_dotenv
load_dotenv()
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx
from agents import deliberate, OLLAMA_URL, MEMORY
import threading
import llm_agent
MODEL = llm_agent.MODEL

app = FastAPI(title='FieldOps Explainer Agent API', version='0.6.0')
# 'ollama' = Explainer uses the local LLM (falls back to templates if it is down); 'mock' = templates only.
AI_MODE = os.getenv('AI_MODE', 'ollama').lower()
origins = [x.strip() for x in os.getenv('FRONTEND_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST'], allow_headers=['Content-Type'])

class DeliberationRequest(BaseModel):
    event: str = Field(default='operator_review', max_length=100)
    state: dict
    jobId: str | None = None
    includeAgronomy: bool = False

@app.get('/api/health')
async def health():
    if AI_MODE == 'mock':
        return {'backend': 'online', 'ollama': 'mock', 'model': MODEL, 'models': [], 'mode': 'mock'}
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f'{OLLAMA_URL}/api/tags')
            r.raise_for_status()
            models = [m.get('name') for m in r.json().get('models', [])]
        return {'backend': 'online', 'ollama': 'online', 'model': MODEL, 'models': models}
    except (httpx.HTTPError, ValueError):
        return {'backend': 'online', 'ollama': 'offline', 'model': MODEL, 'models': []}

@app.post('/api/agents/deliberate')
async def agent_deliberate(request: DeliberationRequest):
    return await deliberate(request.model_dump(), use_llm=(AI_MODE == 'ollama'))

@app.get('/api/agents/memory')
def memory():
    return {k: v[-20:] for k, v in MEMORY.items()}


# ── Explainer Agent (LLM only talks; decisions come from the deterministic agents in the simulator) ──
class ExplainRequest(BaseModel):
    diff: dict
    template: str = Field(max_length=4000)

class WhyRequest(BaseModel):
    question: str = Field(max_length=500)
    facts: dict
    template: str = Field(max_length=4000)

def _template(template):
    return {'text': template, 'source': 'template', 'model': None}

@app.on_event('startup')
def _warmup():
    if AI_MODE == 'ollama':
        threading.Thread(target=llm_agent.warmup, daemon=True).start()

# Plain `def` endpoints run in FastAPI's threadpool, so slow LLM calls never block the server.
@app.post('/api/explain')
def explain(request: ExplainRequest):
    return llm_agent.explain_replan(request.diff, request.template) if AI_MODE == 'ollama' else _template(request.template)

@app.post('/api/why')
def why(request: WhyRequest):
    return llm_agent.answer_why(request.question, request.facts, request.template) if AI_MODE == 'ollama' else _template(request.template)
