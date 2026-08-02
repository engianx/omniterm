import { describe, it } from 'node:test';
import assert from 'node:assert';
import { decodeOsc52Payload } from './osc52.js';

describe('decodeOsc52Payload', () => {
  it('decodes ASCII with a c (clipboard) selection prefix', () => {
    assert.strictEqual(decodeOsc52Payload('c;aGVsbG8='), 'hello');
  });

  it('decodes with an empty selection prefix', () => {
    assert.strictEqual(decodeOsc52Payload(';aGVsbG8='), 'hello');
  });

  it("decodes with multiple selection chars (tmux emits 'cp' sometimes)", () => {
    assert.strictEqual(decodeOsc52Payload('cp;aGVsbG8='), 'hello');
  });

  it('decodes UTF-8 multibyte text', () => {
    // base64(UTF-8 of "こんにちは") = "44GT44KT44Gr44Gh44Gv"
    assert.strictEqual(decodeOsc52Payload('c;44GT44KT44Gr44Gh44Gv'), 'こんにちは');
  });

  it('returns null for the query form (?)', () => {
    assert.strictEqual(decodeOsc52Payload('c;?'), null);
  });

  it('returns null when the base64 payload is empty', () => {
    assert.strictEqual(decodeOsc52Payload('c;'), null);
  });

  it('returns null when there is no semicolon separator', () => {
    assert.strictEqual(decodeOsc52Payload('garbage'), null);
  });

  it('returns null for invalid base64', () => {
    assert.strictEqual(decodeOsc52Payload('c;@@@'), null);
  });
});
