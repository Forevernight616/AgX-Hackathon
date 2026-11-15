"""Explainer Agent: the only agent that uses an LLM (local Ollama).

The LLM talks to the farmer; code makes the decisions. This module never decides
anything. It rewrites facts produced by the deterministic agents (src/engine/agents.js)
into short plain language. Every function falls back to the deterministic template
sentence if Ollama is down, slow, or returns nothing, so the demo can't break.

Standard library only.
"""
import json
import os
import re
import urllib.error
import urllib.request

OLLAMA_URL = os.getenv('OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
MODEL = os.getenv('OLLAMA_MODEL', 'qwen3.5:4b')
# Optional second model to try if the first fails. Empty by default to keep memory use low.
FALLBACK_MODEL = os.getenv('OLLAMA_FALLBACK_MODEL', '')
TIMEOUT = float(os.getenv('OLLAMA_TIMEOUT', '45'))

SYSTEM = (
    'You are the Explainer Agent for an autonomous farm fleet. Deterministic code has already '
    'made and safety-checked every decision. Your only job is to explain those decisions to a farm '
    'operator in plain English. Use ONLY the facts given. Never invent numbers, tractors, fields or '
    'reasons. Never suggest a different assignment. No markdown, no bullet points, no preamble.'
)


def _chat(prompt, model, max_tokens=220):
    body = json.dumps({
        'model': model,
        'stream': False,
        'think': False,
        'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}],
        'options': {'temperature': 0.2, 'num_ctx': 8192, 'num_predict': max_tokens},
    }).encode()
    req = urllib.request.Request(f'{OLLAMA_URL}/api/chat', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        text = json.loads(r.read())['message']['content']
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.S).strip()
    if not text:
        raise ValueError('empty response')
    return text


def ask(prompt, template, max_tokens=220):
    """Return {'text', 'source', 'model'}; falls back to the template on any failure."""
    last = 'no model configured'
    for model in [m for m in (MODEL, FALLBACK_MODEL) if m]:
        try:
            return {'text': _chat(prompt, model, max_tokens), 'source': 'llm', 'model': model}
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError) as exc:
            last = f'{type(exc).__name__}: {exc}'
    return {'text': template, 'source': 'template', 'model': None, 'error': last}


def explain_replan(diff, template):
    prompt = (
        'A replan just happened. Explain it to the operator in 2-4 short sentences. '
        'Lead with what triggered it, then who does what now and why (cite the given fuel/ETA/deadline numbers), '
        'say explicitly if partial work was kept, mention any Safety veto or refuel stop, and end with any job at risk. '
        f'\n\nFACTS (plan diff):\n{json.dumps(diff, indent=1)}\n\nREFERENCE SUMMARY (correct but robotic):\n{template}'
    )
    return ask(prompt, template)


def answer_why(question, facts, template):
    prompt = (
        f'The operator asks: "{question}"\n'
        'Answer in 1-3 sentences using only these facts. The "bids" show each tractor\'s auction answer; '
        'lower cost wins. If a "what_if" is present, use it to answer contrastively (what would happen with the alternative).'
        f'\n\nFACTS:\n{json.dumps(facts, indent=1)}\n\nREFERENCE ANSWER:\n{template}'
    )
    return ask(prompt, template, max_tokens=160)


def warmup():
    """Load the model into memory so the first demo explanation is fast."""
    try:
        _chat('Say OK.', MODEL, max_tokens=4)
        return True
    except Exception:  # noqa: BLE001 - warmup is best effort
        return False


if __name__ == '__main__':
    print(warmup())
    print(explain_replan({'trigger': 'BREAKDOWN T1 during J1 (33% done)',
                          'moved': [{'job': 'J1 harvest North Wheat (remaining 67%)', 'from': 'T1', 'to': 'T3', 'kept': '33% kept',
                                     'reason': 'only valid bidder; fuel 84%, ETA t=33.5, deadline t=37'}]},
                         'J1 moves from T1 to T3 (33% kept).'))
