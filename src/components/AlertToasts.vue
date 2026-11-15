<script setup>
// Top-left alert pop-ups for events where something is really wrong: breakdowns, running out of fuel,
// safety invariant violations, missed deadlines and agent escalations that need the operator.
// Breakdown alerts update live with what the agents are doing about it (rescue designation / stranded).
import {ref, watch, onUnmounted} from 'vue';
import {AlertTriangle, Fuel, ShieldAlert, Clock3, Siren, X} from 'lucide-vue-next';

const props = defineProps({sim: Object});
const emit = defineEmits(['select']);
const toasts = ref([]);
const MAX = 4, LIFETIME_MS = 14000;
let seenLog = 0, seenMsg = 0, nextId = 1;
const timers = new Map();

function classify(s, l) {
  if (l.type === 'critical') {
    const t = s.tractors.find(t => l.message.startsWith(t.name));
    if (/BROKEN DOWN/.test(l.message)) return {kind: 'breakdown', icon: AlertTriangle, title: `${t?.id || 'Tractor'} broke down`, text: `${t?.name || 'A tractor'} is offline.`, tractorId: t?.id, sticky: true};
    if (/ran out of fuel/.test(l.message)) return {kind: 'fuel', icon: Fuel, title: `${t?.id || 'Tractor'} ran out of fuel`, text: l.message, tractorId: t?.id, sticky: true};
    if (/INVARIANT VIOLATED/.test(l.message)) return {kind: 'safety', icon: ShieldAlert, title: 'Safety invariant violated', text: l.message.replace('INVARIANT VIOLATED: ', ''), sticky: true};
    return {kind: 'safety', icon: ShieldAlert, title: 'Unsafe assignment blocked', text: l.message};
  }
  if (l.type === 'warning' && /deadline missed/i.test(l.message)) return {kind: 'deadline', icon: Clock3, title: 'Deadline missed', text: l.message};
  return null;
}

function push(a, time) {
  const id = nextId++;
  toasts.value.unshift({id, time, ...a});
  while (toasts.value.length > MAX) dismiss(toasts.value.at(-1).id);
  if (!a.sticky) timers.set(id, setTimeout(() => dismiss(id), LIFETIME_MS));
}
function dismiss(id) {
  clearTimeout(timers.get(id)); timers.delete(id);
  toasts.value = toasts.value.filter(t => t.id !== id);
}
onUnmounted(() => timers.forEach(clearTimeout));

watch(() => [props.sim, props.sim.logs[0]?.id, props.sim.messages.length], ([s], [prev] = []) => {
  if (s !== prev) {
    // New / reset simulation: start fresh and don't replay its history.
    toasts.value = []; timers.forEach(clearTimeout); timers.clear();
    seenLog = s.logs[0]?.id || 0; seenMsg = s.messages.at(-1)?.id || 0;
    return;
  }
  for (const l of s.logs.filter(l => l.id > seenLog).reverse()) { const a = classify(s, l); if (a) push(a, l.time); }
  seenLog = s.logs[0]?.id || seenLog;
  for (const m of s.messages.filter(m => m.id > seenMsg)) {
    if (m.kind === 'ESCALATE') push({kind: 'escalate', icon: Siren, title: 'Operator action needed', text: m.detail, sticky: true}, m.time);
  }
  seenMsg = s.messages.at(-1)?.id || seenMsg;
}, {immediate: true});

// Live follow-up line for breakdowns: what the agents decided.
function followUp(a) {
  if (a.kind !== 'breakdown' || !a.tractorId) return null;
  const s = props.sim, t = s.tractors.find(t => t.id === a.tractorId);
  if (t?.status !== 'broken') return {ok: true, text: `${a.tractorId} is back in service.`};
  const entry = Object.entries(s.pledges || {}).find(([, p]) => p.from === a.tractorId);
  if (!entry) {
    const done = s.messages.some(m => m.kind === 'RESCUE_COMPLETE' && m.detail.includes(`${a.tractorId} left behind`));
    return done ? {ok: true, text: 'Agents finished its abandoned work.'} : {ok: true, text: 'It had no active job: no work lost.'};
  }
  const [jobId, p] = entry;
  if (p.state === 'stranded') return {ok: false, text: `No tractor can finish ${jobId}. Repair ${a.tractorId}.`};
  if (p.state === 'en route') return {ok: true, text: `${p.tractorId} is on its way to finish ${jobId}.`};
  return {ok: true, text: `Agents designated ${p.tractorId} to finish ${jobId} (on site ~t=${Math.round(p.arrive)}).`};
}
const fmt = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
</script>

<template>
<div class="alert-stack" aria-live="assertive">
  <TransitionGroup name="alert">
    <div v-for="a in toasts" :key="a.id" class="alert-toast" :class="a.kind" role="alert" @click="a.tractorId&&emit('select','tractor',a.tractorId)">
      <component :is="a.icon" :size="20" class="alert-icon"/>
      <div class="alert-body">
        <div class="alert-title">{{a.title}} <span>t={{fmt(a.time)}}</span></div>
        <p>{{a.text}}</p>
        <p v-if="followUp(a)" class="alert-follow" :class="{bad:!followUp(a).ok}">{{followUp(a).text}}</p>
      </div>
      <button class="alert-close" aria-label="Dismiss alert" @click.stop="dismiss(a.id)"><X :size="15"/></button>
    </div>
  </TransitionGroup>
</div>
</template>

<style scoped>
.alert-stack { position: fixed; top: 84px; left: 16px; z-index: 60; display: flex; flex-direction: column; gap: 10px; width: min(380px, calc(100vw - 32px)); pointer-events: none; }
.alert-toast { pointer-events: auto; display: flex; gap: 12px; align-items: flex-start; padding: 12px 12px 12px 14px; border-radius: 10px; background: #2a1517; border: 1px solid #c4534a; border-left: 5px solid #ff6b5e; box-shadow: 0 12px 32px rgba(0, 0, 0, .5); color: #ffe3df; cursor: default; }
.alert-toast.breakdown, .alert-toast.fuel { cursor: pointer; }
.alert-toast.deadline { background: #2a2214; border-color: #b8893b; border-left-color: #f0b04f; color: #fbecd0; }
.alert-toast.escalate { animation: pulse 1.4s ease-in-out infinite; }
.alert-icon { flex: none; margin-top: 2px; color: #ff8a7d; }
.deadline .alert-icon { color: #f6c26b; }
.alert-body { flex: 1; min-width: 0; }
.alert-title { font: 700 13px 'Space Grotesk', 'DM Sans', sans-serif; letter-spacing: .3px; display: flex; justify-content: space-between; gap: 8px; }
.alert-title span { font: 500 11px ui-monospace, monospace; opacity: .7; }
.alert-body p { margin: 4px 0 0; font-size: 12px; line-height: 1.45; opacity: .92; }
.alert-follow { padding-top: 6px; border-top: 1px solid rgba(255, 255, 255, .12); color: #9fe6b8; }
.alert-follow.bad { color: #ffb0a6; font-weight: 600; }
.alert-close { flex: none; background: none; border: 0; color: inherit; opacity: .6; cursor: pointer; padding: 2px; }
.alert-close:hover { opacity: 1; }
.alert-enter-active { transition: all .35s cubic-bezier(.2, 1.2, .4, 1); }
.alert-leave-active { transition: all .25s ease-in; }
.alert-enter-from { opacity: 0; transform: translateX(-30px); }
.alert-leave-to { opacity: 0; transform: translateX(-30px); }
@keyframes pulse { 0%, 100% { box-shadow: 0 12px 32px rgba(0, 0, 0, .5), 0 0 0 0 rgba(255, 107, 94, .5); } 50% { box-shadow: 0 12px 32px rgba(0, 0, 0, .5), 0 0 0 6px rgba(255, 107, 94, 0); } }
</style>
