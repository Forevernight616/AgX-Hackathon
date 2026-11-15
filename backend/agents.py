"""Event-driven advisory multi-agent service. Safety remains deterministic."""
import os
import math
import json
from collections import defaultdict
import httpx

OLLAMA_URL = os.getenv('OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
MODEL = os.getenv('OLLAMA_MODEL', 'llama3.2')
MEMORY = defaultdict(list)


def remember(agent, event):
    MEMORY[agent].append(event)
    if len(MEMORY[agent]) > 60:
        MEMORY[agent] = MEMORY[agent][-60:]


def eligible(tractor, job, fields, now):
    implements = {'sprayer': {'spray'}, 'mower': {'mow'}, 'harvester': {'harvest'}, 'multi': {'spray', 'mow', 'harvest'}}
    capabilities = set(tractor.get('capabilities', []))
    for implement in tractor.get('implements', []):
        capabilities |= implements.get(implement, set())
    if tractor.get('status') != 'idle' or job.get('type') not in capabilities:
        return None
    field = next((f for f in fields if f['id'] == job.get('fieldId')), None)
    if not field:
        return None
    x = field['x'] + (field.get('w', 1)-1)/2
    y = field['y'] + (field.get('h', 1)-1)/2
    distance = math.hypot(x-tractor['x'], y-tractor['y'])
    speed = max(float(tractor.get('speed', 1)), 0.001)
    duration = float(job.get('duration', 0)) * (1-float(job.get('progress', 0)))
    fuel = distance * float(tractor.get('travelBurn', 0.75)) + duration * float(tractor.get('workBurn', 0.85))
    finish = now + distance/speed + duration
    if fuel > float(tractor.get('fuel', 0)) or finish > float(job.get('deadline', 0)):
        return None
    return {'tractorId': tractor['id'], 'jobId': job['id'], 'distance': round(distance, 2), 'fuelRequired': round(fuel, 2), 'estimatedFinish': round(finish, 2)}


async def ask_model(role, event, context):
    prompt = ('You are the ' + role + ' of a simulated autonomous farm fleet. '
              'You may only advise; hard safety checks and dispatch are performed by deterministic software. '
              'Use the provided facts, never invent fuel levels or routes. '
              'Respond concisely in plain English, at most 80 words. '
              'Event and state: ' + json.dumps({'event': event, 'context': context}, default=str))
    async with httpx.AsyncClient(timeout=35.0) as client:
        response = await client.post(f'{OLLAMA_URL}/api/chat', json={
            'model': MODEL, 'stream': False,
            'messages': [{'role': 'system', 'content': 'You are an advisory farm agent. Never issue commands.'}, {'role': 'user', 'content': prompt}],
            'options': {'temperature': 0.1, 'num_predict': 140}
        })
        response.raise_for_status()
        return response.json()['message']['content'].strip()


async def deliberate(payload, use_llm=True):
    event = payload.get('event', 'operator_review')
    state = payload['state']
    tractors, jobs, fields = state.get('tractors', []), state.get('jobs', []), state.get('fields', [])
    now = float(state.get('time', 0))
    target = payload.get('jobId')
    pending = [j for j in jobs if j.get('status') == 'pending' and (not target or j['id'] == target)]
    proposals = [bid for job in pending for tractor in tractors if (bid := eligible(tractor, job, fields, now))]
    proposals.sort(key=lambda b: (next(j for j in jobs if j['id'] == b['jobId']).get('priority', 1)*-1000 + b['distance']*10 + b['estimatedFinish'], b['tractorId']))
    chosen = []
    occupied_tractors, occupied_jobs = set(), set()
    for bid in proposals:
        if bid['tractorId'] not in occupied_tractors and bid['jobId'] not in occupied_jobs:
            chosen.append(bid)
            occupied_tractors.add(bid['tractorId']); occupied_jobs.add(bid['jobId'])
    messages = [{'from': 'Fleet Agent', 'to': 'Tractor Fleet', 'kind': 'CALL_FOR_PROPOSALS', 'detail': f'{len(pending)} pending jobs'}]
    for bid in proposals[:50]:
        messages.append({'from': bid['tractorId'], 'to': 'Fleet Agent', 'kind': 'PROPOSAL', 'detail': f"{bid['jobId']}: travel {bid['distance']}, fuel {bid['fuelRequired']}, ETA {bid['estimatedFinish']}"})
    for bid in chosen:
        messages.append({'from': 'Safety Agent', 'to': 'Fleet Agent', 'kind': 'VALIDATED', 'detail': f"{bid['tractorId']} / {bid['jobId']}: compatible, fuel and deadline feasible; unique assignment"})
        messages.append({'from': 'Fleet Agent', 'to': bid['tractorId'], 'kind': 'RECOMMENDATION', 'detail': f"Recommend {bid['jobId']} (advisory only)"})
    for tractor in tractors:
        if any(b['tractorId'] == tractor['id'] for b in proposals):
            remember(tractor['id'], {'time': now, 'event': event, 'proposals': [b['jobId'] for b in proposals if b['tractorId'] == tractor['id']]})
    remember('Fleet Agent', {'time': now, 'event': event, 'recommended': chosen})
    context = {'time': now, 'proposals': proposals[:12], 'recommended': chosen, 'recentMemory': MEMORY['Fleet Agent'][-5:]}
    advice = {}
    errors = []
    for role in ['Fleet Agent', 'Navigation Agent', 'Safety Agent']:
        if not use_llm:
            advice[role] = f'MOCK {role}: {len(chosen)} safety-screened assignment recommendations. Switch AI_MODE=ollama to use the local model.'
            messages.append({'from': role, 'to': 'Command Center', 'kind': 'MOCK_ADVICE', 'detail': advice[role]})
            continue
        try:
            advice[role] = await ask_model(role, event, context)
            remember(role, {'time': now, 'event': event, 'response': advice[role]})
            messages.append({'from': role, 'to': 'Command Center', 'kind': 'LLM_ADVICE', 'detail': advice[role]})
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            errors.append(f'{role}: {type(exc).__name__} (check Ollama connectivity and model)')
            advice[role] = 'LLM unavailable; deterministic eligibility checks remain operational.'
    if payload.get('includeAgronomy'):
        if not use_llm:
            advice['Agronomy Agent'] = 'MOCK Agronomy Agent: crop recommendations are not evaluated in mock mode.'
            messages.append({'from': 'Agronomy Agent', 'to': 'Command Center', 'kind': 'MOCK_ADVICE', 'detail': advice['Agronomy Agent']})
        else:
          try:
            advice['Agronomy Agent'] = await ask_model('Agronomy Agent', event, {'fields': fields, 'jobs': pending[:10]})
            messages.append({'from': 'Agronomy Agent', 'to': 'Command Center', 'kind': 'LLM_ADVICE', 'detail': advice['Agronomy Agent']})
          except (httpx.HTTPError, KeyError, ValueError):
            errors.append('Agronomy Agent unavailable')
    return {'event': event, 'time': now, 'proposals': proposals, 'recommended': chosen, 'messages': messages, 'advice': advice, 'errors': errors, 'mode': 'ollama-advisory' if use_llm else 'mock-advisory', 'memoryCounts': {k: len(v) for k,v in MEMORY.items()}}
