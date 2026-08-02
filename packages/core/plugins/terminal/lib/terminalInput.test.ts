import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  controlByteForLetter,
  arrowSequence,
  getTerminal,
  sendData,
  sendDescriptor,
  sendControlLetter,
  sendComposed,
  ctrlReducer,
  KEY_BAR,
  ESC,
  TAB,
  ETX,
  type KeyDescriptor,
} from './terminalInput.js';

/** A fake iframe contentWindow whose `term` records every input() call. */
function fakeWin(opts?: { applicationCursorMode?: boolean; noModes?: boolean; noInput?: boolean }) {
  const writes: string[] = [];
  const term: Record<string, unknown> = {
    input: opts?.noInput ? undefined : (data: string) => writes.push(data),
  };
  if (!opts?.noModes) {
    term.modes = { applicationCursorKeysMode: !!opts?.applicationCursorMode };
  }
  return { win: { term } as unknown as Window, writes };
}

describe('controlByteForLetter', () => {
  it('maps c → \\x03 (Ctrl-C)', () => assert.strictEqual(controlByteForLetter('c'), '\x03'));
  it('maps a → \\x01 and z → \\x1a', () => {
    assert.strictEqual(controlByteForLetter('a'), '\x01');
    assert.strictEqual(controlByteForLetter('z'), '\x1a');
  });
  it('is case-insensitive (C === c)', () =>
    assert.strictEqual(controlByteForLetter('C'), controlByteForLetter('c')));
  it('returns null for non-letters', () => {
    assert.strictEqual(controlByteForLetter('1'), null);
    assert.strictEqual(controlByteForLetter('-'), null);
    assert.strictEqual(controlByteForLetter(''), null);
    assert.strictEqual(controlByteForLetter('ab'), null);
  });
  it('returns null for non-ASCII letters (no stray control byte)', () => {
    // 'ß'.toUpperCase() === 'SS', 'ı'.toUpperCase() === 'I' — must not emit Ctrl-S/Tab.
    assert.strictEqual(controlByteForLetter('ß'), null);
    assert.strictEqual(controlByteForLetter('ı'), null);
    assert.strictEqual(controlByteForLetter('é'), null);
  });
});

describe('arrowSequence', () => {
  it('emits normal cursor sequences (ESC[A..D)', () => {
    assert.strictEqual(arrowSequence('up', false), `${ESC}[A`);
    assert.strictEqual(arrowSequence('down', false), `${ESC}[B`);
    assert.strictEqual(arrowSequence('right', false), `${ESC}[C`);
    assert.strictEqual(arrowSequence('left', false), `${ESC}[D`);
  });
  it('emits application-cursor sequences (ESC O A..D) under DECCKM', () => {
    assert.strictEqual(arrowSequence('up', true), `${ESC}OA`);
    assert.strictEqual(arrowSequence('down', true), `${ESC}OB`);
    assert.strictEqual(arrowSequence('right', true), `${ESC}OC`);
    assert.strictEqual(arrowSequence('left', true), `${ESC}OD`);
  });
});

describe('getTerminal (feature detection)', () => {
  it('returns the term when input() and modes are present', () => {
    const { win } = fakeWin();
    assert.notStrictEqual(getTerminal(win), null);
  });
  it('returns null when term is missing / null win / no input / no modes — never throws', () => {
    assert.strictEqual(getTerminal(null), null);
    assert.strictEqual(getTerminal(undefined), null);
    assert.strictEqual(getTerminal({} as Window), null);
    assert.strictEqual(getTerminal(fakeWin({ noInput: true }).win), null);
    assert.strictEqual(getTerminal(fakeWin({ noModes: true }).win), null);
  });
});

describe('sendData', () => {
  it('writes the exact bytes and returns true', () => {
    const { win, writes } = fakeWin();
    assert.strictEqual(sendData(win, ETX), true);
    assert.deepStrictEqual(writes, [ETX]);
  });
  it('returns false (no throw) when the terminal is unavailable', () => {
    assert.strictEqual(sendData(null, ETX), false);
    assert.strictEqual(sendData({} as Window, ETX), false);
  });
});

describe('sendDescriptor', () => {
  const byId = (id: string): KeyDescriptor => {
    const d = KEY_BAR.find((k) => k.id === id);
    if (!d) throw new Error(`no key ${id}`);
    return d;
  };

  it('sends Esc/Tab/Ctrl-C as their control bytes', () => {
    const { win, writes } = fakeWin();
    sendDescriptor(win, byId('esc'));
    sendDescriptor(win, byId('tab'));
    sendDescriptor(win, byId('ctrl-c'));
    assert.deepStrictEqual(writes, [ESC, TAB, ETX]);
  });

  it('sends arrows mode-faithfully (normal vs application-cursor)', () => {
    const normal = fakeWin({ applicationCursorMode: false });
    sendDescriptor(normal.win, byId('up'));
    assert.deepStrictEqual(normal.writes, [`${ESC}[A`]);

    const app = fakeWin({ applicationCursorMode: true });
    sendDescriptor(app.win, byId('up'));
    assert.deepStrictEqual(app.writes, [`${ESC}OA`]);
  });

  it('sends symbol keys as literal characters', () => {
    const { win, writes } = fakeWin();
    sendDescriptor(win, byId('pipe'));
    assert.deepStrictEqual(writes, ['|']);
  });

  it('returns false when the terminal is unavailable', () => {
    assert.strictEqual(sendDescriptor(null, byId('esc')), false);
  });
});

describe('sendControlLetter', () => {
  it('sends the control byte for a letter', () => {
    const { win, writes } = fakeWin();
    assert.strictEqual(sendControlLetter(win, 'r'), true);
    assert.deepStrictEqual(writes, ['\x12']); // Ctrl-R
  });
  it('is a no-op for non-letters', () => {
    const { win, writes } = fakeWin();
    assert.strictEqual(sendControlLetter(win, '5'), false);
    assert.deepStrictEqual(writes, []);
  });
});

describe('sendComposed', () => {
  it('sends text once with no trailing CR when run=false', () => {
    const { win, writes } = fakeWin();
    assert.strictEqual(sendComposed(win, 'ls -la', false), true);
    assert.deepStrictEqual(writes, ['ls -la']);
  });
  it('appends a carriage return to execute when run=true', () => {
    const { win, writes } = fakeWin();
    sendComposed(win, 'ls -la', true);
    assert.deepStrictEqual(writes, ['ls -la\r']);
  });
  it('never bracket-wraps (sends the raw text, not ESC[200~…)', () => {
    const { win, writes } = fakeWin();
    sendComposed(win, 'abc', false);
    assert.deepStrictEqual(writes, ['abc']);
  });
  it('empty text is a no-op', () => {
    const { win, writes } = fakeWin();
    assert.strictEqual(sendComposed(win, '', true), false);
    assert.deepStrictEqual(writes, []);
  });
});

describe('ctrlReducer (sticky one-shot modifier)', () => {
  it('toggle arms from idle and disarms from armed', () => {
    assert.strictEqual(ctrlReducer('idle', 'toggle'), 'armed');
    assert.strictEqual(ctrlReducer('armed', 'toggle'), 'idle');
  });
  it('consume and clear return to idle', () => {
    assert.strictEqual(ctrlReducer('armed', 'consume'), 'idle');
    assert.strictEqual(ctrlReducer('armed', 'clear'), 'idle');
  });
});
