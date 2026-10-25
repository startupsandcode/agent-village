import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/workflow.js', import.meta.url), 'utf8');

function bootDemo() {
  const elements = new Map();
  class Element {
    disabled = false;
    textContent = '';
    listeners = new Map();
    focused = false;
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    click() { if (!this.disabled) this.listeners.get('click')?.(); }
    focus() { this.focused = true; }
  }
  for (const id of ['advance', 'cancel', 'reset', 'mission-status', 'status-message', 'retry-count']) {
    elements.set(id, new Element());
  }
  elements.get('status-message').textContent = 'Ready. This illustration allows two retries after an initial failed check.';
  elements.get('retry-count').textContent = 'Retries used: 0 of 2.';
  vm.runInNewContext(source, { document: { getElementById: id => elements.get(id) } });
  return Object.fromEntries([...elements].map(([id, element]) => [id, element]));
}

test('Workflow retry demonstration stops after two retries and ignores further attempts', () => {
  const ui = bootDemo();
  assert.match(ui['status-message'].textContent, /Ready.*two retries/i);
  assert.equal(ui['retry-count'].textContent, 'Retries used: 0 of 2.');
  ui.advance.click();
  assert.match(ui['status-message'].textContent, /Retry available: 1 of 2/);
  assert.equal(ui['retry-count'].textContent, 'Retries used: 0 of 2.');
  ui.advance.click();
  assert.match(ui['status-message'].textContent, /Retry available: 2 of 2/);
  assert.equal(ui['retry-count'].textContent, 'Retries used: 1 of 2.');
  ui.advance.click();
  assert.match(ui['status-message'].textContent, /Retry limit reached/);
  assert.equal(ui['retry-count'].textContent, 'Retries used: 2 of 2.');
  assert.equal(ui.advance.disabled, true);
  ui.advance.click();
  assert.match(ui['status-message'].textContent, /Retry limit reached/);
});

test('Workflow cancellation halts the illustration and reset restores its controls', () => {
  const ui = bootDemo();
  ui.cancel.click();
  assert.match(ui['status-message'].textContent, /Cancelled/);
  assert.equal(ui.advance.disabled, true);
  assert.equal(ui.cancel.disabled, true);
  assert.equal(ui['mission-status'].focused, true);
  ui.reset.click();
  assert.match(ui['status-message'].textContent, /Ready/);
  assert.equal(ui['retry-count'].textContent, 'Retries used: 0 of 2.');
  assert.equal(ui.advance.disabled, false);
  assert.equal(ui.cancel.disabled, false);
});
