/**
 * Node smoke test for the pure billing-period logic in ../client.js.
 *
 * The client module is a browser script that registers itself on
 * `window.__ModuleLoader__`, so this harness stubs that global, evaluates the
 * file, and pulls the exported `billingPeriod` test seam out of the factory.
 *
 * Run: node test/logic.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};
// Node exposes a getter-only `navigator`; redefine it so the locale fallback is deterministic.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });

// eslint-disable-next-line no-new-func
new Function(source)();

assert.equal(registrations.length, 1, 'client.js must register exactly one module');
assert.equal(registrations[0].id, 'dsh-deepseek-billing-period');

const reactStub = { createElement() {}, useState() {}, useEffect() {} };
const moduleExports = registrations[0].factory((specifier) => {
  if (specifier === 'react') return reactStub;
  throw new Error('unexpected require: ' + specifier);
});

assert.equal(typeof moduleExports.apply, 'function', 'client module must export apply');
assert.deepEqual(moduleExports.inject, ['slots']);
const logic = moduleExports.billingPeriod;
assert.ok(logic, 'billingPeriod test seam must be exported');

/** Epoch ms of a Beijing wall-clock time. */
function bj(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - logic.BJ_OFFSET_MS;
}

function at(ms) {
  return logic.fieldsAt(ms);
}

function state(ms) {
  return logic.evaluate(ms).peak ? 'peak' : 'off-peak';
}

let checks = 0;
function expectState(label, ms, expected) {
  checks += 1;
  assert.equal(state(ms), expected, label);
}
function expectChange(label, ms, expectedMs, expectedPeak) {
  checks += 1;
  const change = logic.nextChange(ms);
  assert.ok(change, label + ': a transition must exist');
  assert.equal(change.at, expectedMs, label + ': transition instant');
  assert.equal(change.peak, expectedPeak, label + ': target state');
}

// --- Beijing wall-clock mapping (independent of the host time zone) ---------
checks += 1;
assert.deepEqual(
  {
    year: at(bj(2026, 10, 8, 16, 19, 30)).year,
    month: at(bj(2026, 10, 8, 16, 19, 30)).month,
    day: at(bj(2026, 10, 8, 16, 19, 30)).day,
    hour: at(bj(2026, 10, 8, 16, 19, 30)).hour,
    minute: at(bj(2026, 10, 8, 16, 19, 30)).minute,
    second: at(bj(2026, 10, 8, 16, 19, 30)).second,
    weekday: at(bj(2026, 10, 8, 16, 19, 30)).weekday,
  },
  { year: 2026, month: 10, day: 8, hour: 16, minute: 19, second: 30, weekday: 4 },
  'UTC+8 field mapping',
);

// --- Peak windows on an ordinary workday (Thu 2026-10-08) -------------------
expectState('workday 08:59', bj(2026, 10, 8, 8, 59), 'off-peak');
expectState('workday 09:00 (window start is inclusive)', bj(2026, 10, 8, 9, 0), 'peak');
expectState('workday 10:00', bj(2026, 10, 8, 10, 0), 'peak');
expectState('workday 11:59', bj(2026, 10, 8, 11, 59), 'peak');
expectState('workday 12:00 (window end is exclusive)', bj(2026, 10, 8, 12, 0), 'off-peak');
expectState('workday 13:30 lunch break', bj(2026, 10, 8, 13, 30), 'off-peak');
expectState('workday 14:00', bj(2026, 10, 8, 14, 0), 'peak');
expectState('workday 16:19 (near midnight UTC date boundary)', bj(2026, 10, 8, 16, 19), 'peak');
expectState('workday 17:59', bj(2026, 10, 8, 17, 59), 'peak');
expectState('workday 18:00', bj(2026, 10, 8, 18, 0), 'off-peak');
expectState('workday 23:30', bj(2026, 10, 8, 23, 30), 'off-peak');

// --- Transitions -----------------------------------------------------------
expectChange('08:59 -> 09:00 peak', bj(2026, 10, 8, 8, 59), bj(2026, 10, 8, 9, 0), true);
expectChange('11:00 -> 12:00 off-peak', bj(2026, 10, 8, 11, 0), bj(2026, 10, 8, 12, 0), false);
expectChange('12:30 -> 14:00 peak', bj(2026, 10, 8, 12, 30), bj(2026, 10, 8, 14, 0), true);
expectChange('16:00 -> 18:00 off-peak', bj(2026, 10, 8, 16, 0), bj(2026, 10, 8, 18, 0), false);
expectChange('18:00 -> next workday 09:00', bj(2026, 10, 8, 18, 0), bj(2026, 10, 9, 9, 0), true);
expectChange('09:00 -> 12:00 off-peak', bj(2026, 10, 8, 9, 0), bj(2026, 10, 8, 12, 0), false);

// --- Weekends are off-peak all day ----------------------------------------
expectState('Saturday 10:00', bj(2026, 10, 10, 10, 0), 'off-peak');
expectState('Sunday 16:00', bj(2026, 10, 11, 16, 0), 'off-peak');
expectChange(
  'Friday 20:00 -> Monday 09:00 (weekend skipped)',
  bj(2026, 10, 9, 20, 0),
  bj(2026, 10, 12, 9, 0),
  true,
);

// --- Chinese public holidays -----------------------------------------------
expectState('2026 National Day 10:00', bj(2026, 10, 1, 10, 0), 'off-peak');
checks += 1;
assert.equal(logic.holidayNameAt(bj(2026, 10, 1, 10, 0)), 'holiday.nationalDay');
expectChange(
  'National Day -> 2026-10-08 09:00 (holiday runs Oct 1-7)',
  bj(2026, 10, 1, 10, 0),
  bj(2026, 10, 8, 9, 0),
  true,
);
expectChange(
  'holiday eve 2026-10-07 20:00 -> 2026-10-08 09:00',
  bj(2026, 10, 7, 20, 0),
  bj(2026, 10, 8, 9, 0),
  true,
);
expectState('2025 National Day 2025-10-08 11:00 (8-day holiday)', bj(2025, 10, 8, 11, 0), 'off-peak');
checks += 1;
assert.equal(logic.holidayNameAt(bj(2025, 10, 8, 11, 0)), 'holiday.nationalDayMidAutumn');
expectState('2026 Spring Festival 2026-02-17 15:00', bj(2026, 2, 17, 15, 0), 'off-peak');
checks += 1;
assert.equal(logic.holidayNameAt(bj(2026, 2, 17, 15, 0)), 'holiday.springFestival');
expectState('workday after Spring Festival 2026-02-24 10:00', bj(2026, 2, 24, 10, 0), 'peak');
expectChange(
  'Spring Festival -> 2026-02-24 09:00',
  bj(2026, 2, 16, 10, 0),
  bj(2026, 2, 24, 9, 0),
  true,
);

// --- Year without bundled holiday data -------------------------------------
checks += 1;
assert.deepEqual(logic.holidayYears(), [2025, 2026]);
checks += 1;
assert.equal(logic.coversYear(2027), false);
expectState('uncovered 2027-01-01 (Fri) 10:00 falls back to the weekday rule', bj(2027, 1, 1, 10, 0), 'peak');
expectChange(
  'uncovered 2027-01-01 18:00 -> 2027-01-04 09:00',
  bj(2027, 1, 1, 18, 0),
  bj(2027, 1, 4, 9, 0),
  true,
);

// --- Rendering helper ------------------------------------------------------
checks += 1;
const view = logic.describe(bj(2026, 10, 8, 16, 19), logic.fallbackTranslate);
assert.equal(view.peak, true);
assert.equal(view.label, '高峰时段 · 全价');
assert.match(view.countdown, /^距空闲 /);
assert.equal(view.lines.length, 6, 'six detail lines for a covered workday');
assert.match(view.lines[2], /当前北京时间：2026-10-08 周四 16:19:00/);
assert.match(view.lines[3], /下一时段：空闲时段，北京时间 18:00 起/);

checks += 1;
const uncoveredView = logic.describe(bj(2027, 1, 1, 10, 0), logic.fallbackTranslate);
assert.equal(
  uncoveredView.lines.length,
  7,
  'an uncovered year adds the explicit fallback note',
);
assert.match(uncoveredView.lines[6], /尚未收录 2027 年/);

checks += 1;
assert.equal(
  logic.fallbackTranslate('remaining.hours', { hours: 3, minutes: 5 }),
  '3 小时 5 分',
);
checks += 1;
assert.equal(logic.fallbackTranslate('missing.key'), 'missing.key');

// --- makeTranslate hardening: an unresolvable locale namespace must not leak keys
checks += 1;
const identityT = logic.makeTranslate((key) => key);
assert.equal(identityT('label.peak'), '高峰时段 · 全价', 'unknown namespace falls back to the bundled dictionary');
checks += 1;
assert.equal(identityT('next.toPeak', { remaining: '5 分' }), '距高峰 5 分');
checks += 1;
const partialT = logic.makeTranslate((key) => (key === 'label.offpeak' ? 'OFF-PEAK!' : key));
assert.equal(partialT('label.offpeak'), 'OFF-PEAK!', 'a resolvable key wins over the bundled dictionary');
checks += 1;
assert.equal(partialT('label.peak'), '高峰时段 · 全价');
checks += 1;
assert.equal(logic.makeTranslate(undefined)('label.peak'), '高峰时段 · 全价');

// --- Locale dictionaries are complete and symmetric ------------------------
checks += 1;
assert.deepEqual(Object.keys(logic.DICTS.zh).sort(), Object.keys(logic.DICTS.en).sort());
checks += 1;
for (const key of Object.keys(logic.DICTS.en)) {
  assert.match(key, /^[a-z]+\.[A-Za-z0-9]+$/, 'unexpected dictionary key: ' + key);
}

// --- Preference store: peak-hour send confirmation -------------------------
function memoryStorage(initial) {
  const map = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    dump: () => Object.fromEntries(map),
  };
}

checks += 1;
assert.equal(logic.PREFS_KEY, 'dsh-deepseek-billing-period.prefs');
checks += 1;
assert.deepEqual(logic.DEFAULT_PREFS, { confirmOnPeakSend: true });

checks += 1;
assert.equal(logic.readPrefs(undefined).confirmOnPeakSend, true, 'no store falls back to asking');
checks += 1;
assert.equal(logic.readPrefs(memoryStorage()).confirmOnPeakSend, true, 'empty store asks every time');
checks += 1;
assert.equal(
  logic.readPrefs(memoryStorage({ [logic.PREFS_KEY]: '{"confirmOnPeakSend":false}' })).confirmOnPeakSend,
  false,
);
checks += 1;
assert.equal(
  logic.readPrefs(memoryStorage({ [logic.PREFS_KEY]: 'not json' })).confirmOnPeakSend,
  true,
  'a corrupt value falls back to asking',
);
checks += 1;
assert.equal(
  logic.readPrefs(memoryStorage({ [logic.PREFS_KEY]: '{"confirmOnPeakSend":"no"}' })).confirmOnPeakSend,
  true,
  'only an explicit false disables the confirmation',
);
checks += 1;
assert.equal(logic.readPrefs(memoryStorage({ [logic.PREFS_KEY]: 'null' })).confirmOnPeakSend, true);

checks += 1;
const prefsStore = memoryStorage();
logic.writePrefs(prefsStore, { confirmOnPeakSend: false });
assert.equal(prefsStore.dump()[logic.PREFS_KEY], '{"confirmOnPeakSend":false}');
checks += 1;
assert.equal(logic.readPrefs(prefsStore).confirmOnPeakSend, false, 'the stored opt-out round-trips');
checks += 1;
logic.writePrefs(prefsStore, {});
assert.equal(prefsStore.dump()[logic.PREFS_KEY], '{"confirmOnPeakSend":true}');
checks += 1;
assert.equal(logic.readPrefs(prefsStore).confirmOnPeakSend, true, 'the entry point can turn it back on');

checks += 1;
const hostileStore = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('quota');
  },
};
assert.equal(logic.readPrefs(hostileStore).confirmOnPeakSend, true);
checks += 1;
logic.writePrefs(hostileStore, { confirmOnPeakSend: false }); // must not throw

// --- The send-gesture matcher must never mistake Stop for Send -------------
checks += 1;
for (const label of ['发送消息', '排队发送', '插话发送', 'Send message', 'Queue message', 'Steer message']) {
  assert.ok(logic.SEND_LABEL_RE.test(label), 'send label not matched: ' + label);
}
checks += 1;
for (const label of ['停止生成', 'Stop generating', '发送', '']) {
  assert.equal(logic.SEND_LABEL_RE.test(label), false, 'non-send label matched: ' + label);
}

// --- Confirmation copy is present in both dictionaries ---------------------
checks += 1;
assert.equal(logic.DICTS.zh['dialog.askEvery'], '高峰时段发送消息时，是否需要每次确认');
checks += 1;
assert.equal(logic.DICTS.en['dialog.askEvery'], 'Ask every time before sending during peak hours');
checks += 1;
for (const key of [
  'dialog.title',
  'dialog.description',
  'dialog.confirm',
  'dialog.cancel',
  'dialog.skipHint',
  'setting.confirm',
]) {
  assert.ok(logic.DICTS.zh[key] && logic.DICTS.en[key], 'missing confirmation copy: ' + key);
}

// --- Host components may be forwardRef/memo objects, not functions ---------
checks += 1;
assert.equal(typeof logic.renderable, 'function', 'renderable must be exported');
checks += 1;
for (const value of [function Component() {}, { $$typeof: Symbol.for('react.forward_ref') }]) {
  assert.equal(logic.renderable(value), true, 'a renderable component was rejected');
}
checks += 1;
for (const value of [null, undefined, 'Modal', 42, true]) {
  assert.equal(logic.renderable(value), false, 'a non-component was accepted: ' + String(value));
}

console.log('client billing-period logic: ' + checks + ' checks passed');
