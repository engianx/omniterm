// Decode the body of an OSC 52 clipboard sequence.
//
// When xterm.js's parser invokes an OSC 52 handler, it passes the text
// between the `ESC ] 52 ;` header and the ST/BEL terminator. Body format:
//
//   "<Pc>;<Pd>"
//
// where Pc is one or more selection chars (c/p/s/0-7, possibly empty) and
// Pd is base64-encoded UTF-8 text — or "?" for a query. Returns the
// decoded text, or null for query / empty / malformed input so callers
// can cleanly skip clipboard writes.
export function decodeOsc52Payload(body: string): string | null {
  const semi = body.indexOf(';');
  if (semi < 0) return null;
  const pd = body.slice(semi + 1);
  if (!pd || pd === '?') return null;
  try {
    const bin = atob(pd);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}
