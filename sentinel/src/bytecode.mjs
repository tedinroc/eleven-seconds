// Function-selector extraction from runtime bytecode (the sentinel only sees bytecode: malicious
// implementations are never source-verified). We walk the opcodes (skipping PUSH data) and keep
// every PUSH4 that the solc dispatcher compares against calldata: PUSH4 <sel> followed by EQ or GT
// (GT/LT are the binary-search pivots, which are themselves selectors). PUSH4s used to build custom
// error / panic payloads (PUSH4 <sel> PUSH1 0xe0 SHL ...) are skipped. Over-inclusion is harmless:
// an extra selector is just one more probe call that hits the fallback and reverts.
const PUSH1 = 0x60
const PUSH4 = 0x63
const PUSH32 = 0x7f
const EQ = 0x14
const GT = 0x11
const LT = 0x10
const DUP1 = 0x80
const DUP16 = 0x8f

export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(h.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

export function extractSelectors(codeHex) {
  const code = hexToBytes(codeHex)
  // Strip the CBOR metadata tail (last 2 bytes = its length) so it is not decoded as opcodes.
  let end = code.length
  if (end >= 2) {
    const metaLen = (code[end - 2] << 8) | code[end - 1]
    if (metaLen + 2 <= end && code[end - metaLen - 2] === 0xa2) end = end - metaLen - 2
  }
  const found = new Set()
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc]
    if (op === PUSH4 && pc + 5 < end) {
      let next = code[pc + 5]
      // tolerate one DUPn between the PUSH4 and the comparison
      if (next >= DUP1 && next <= DUP16 && pc + 6 < end) next = code[pc + 6]
      if (next === EQ || next === GT || next === LT) {
        const sel = Array.from(code.slice(pc + 1, pc + 5), (b) => b.toString(16).padStart(2, '0')).join('')
        if (sel !== 'ffffffff' && sel !== '00000000') found.add('0x' + sel)
      }
      pc += 4
    } else if (op >= PUSH1 && op <= PUSH32) {
      pc += op - PUSH1 + 1
    }
  }
  return [...found].sort()
}
