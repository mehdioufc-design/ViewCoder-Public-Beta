import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "ViewCoder Extension/background.js"), "utf8");

function eventSlot() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
  };
}

const runtimeMessage = eventSlot();
const runtimeInstalled = eventSlot();
const runtimeStartup = eventSlot();
const alarmEvent = eventSlot();
const tabRemoved = eventSlot();
const alarms = new Map();
const tabMessages = [];
const storage = {};

const chrome = {
  runtime: {
    getManifest: () => ({ version: "1.0.0" }),
    onMessage: runtimeMessage,
    onInstalled: runtimeInstalled,
    onStartup: runtimeStartup,
  },
  alarms: {
    onAlarm: alarmEvent,
    create(name, info) { alarms.set(name, { ...info }); },
    async clear(name) { return alarms.delete(name); },
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: storage[keys] };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        }
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      },
    },
  },
  tabs: {
    onRemoved: tabRemoved,
    async get(tabId) { return { id: tabId }; },
    async update(tabId, values) { return { id: tabId, ...values }; },
    async create(values) { return { id: 999, ...values }; },
    async sendMessage(tabId, message) {
      tabMessages.push({ tabId, message });
      return { ok: true };
    },
  },
};

vm.runInNewContext(source, {
  chrome,
  console,
  crypto: webcrypto,
  fetch: async () => { throw new Error("network not expected"); },
  AbortController,
  URL,
  TextEncoder,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  btoa: (value) => Buffer.from(String(value), "binary").toString("base64"),
});

assert(runtimeMessage.listeners.length === 1, "Background message listener was not registered.");
assert(alarmEvent.listeners.length === 1, "Background alarm listener was not registered.");

async function send(message, tabId = 77) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Background message timed out.")), 1_000);
    runtimeMessage.listeners[0](message, { tab: { id: tabId } }, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const deadline = Date.now() + 43_000;
const scheduled = await send({
  type: "schedule_watchdog",
  token: "result-reply-test",
  deadline,
});
assert(scheduled.ok === true, "The 43-second watchdog was not scheduled.");
assert(alarms.has(scheduled.name), "The durable service-worker alarm is missing.");
assert(alarms.get(scheduled.name).when >= deadline, "The alarm deadline was shortened.");

alarmEvent.listeners[0]({ name: scheduled.name });
await new Promise((resolve) => setTimeout(resolve, 0));
assert(tabMessages.length === 1, "The hidden provider tab was not awakened.");
assert(tabMessages[0].tabId === 77, "The watchdog woke the wrong provider tab.");
assert(
  tabMessages[0].message.type === "viewcoder-watchdog-tick" &&
  tabMessages[0].message.token === "result-reply-test",
  "The watchdog wake message lost its token.",
);

const cancelled = await send({
  type: "cancel_watchdog",
  token: "result-reply-test",
});
assert(cancelled.ok === true, "The watchdog could not be cancelled.");

console.log("Active Mode durable 43-second watchdog test passed.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
