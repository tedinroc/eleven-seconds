// Static bytecode analysis (the sentinel only sees bytecode: malicious implementations are never
// source-verified). One opcode walker (skips PUSH data and the CBOR metadata tail) feeds:
//  - extractSelectors: every PUSH1-PUSH4 that the solc dispatcher compares against calldata,
//    left-padded to 4 bytes. solc emits the shortest push, so a selector with leading zero bytes
//    (0x00dca85e) is a PUSH3. PUSH4 <sel> [DUPn] EQ|GT|LT (GT/LT are the binary-search pivots, which
//    are themselves selectors). For the shorter pushes, which also appear in ordinary arithmetic, we
//    additionally require the dispatcher shape DUPn PUSHk <sel> [DUPn] EQ|GT|LT PUSHm <dest> JUMPI.
//    PUSH4s used to build custom error / panic payloads (PUSH4 <sel> PUSH1 0xe0 SHL ...) are skipped.
//    Over-inclusion is harmless: an extra selector is just one more probe that hits the fallback.
//  - dangerousOpcodes (R9): block/tx context and external-call / create / selfdestruct opcodes.
const PUSH1 = 0x60
const PUSH4 = 0x63
const PUSH32 = 0x7f
const EQ = 0x14
const GT = 0x11
const LT = 0x10
const DUP1 = 0x80
const DUP16 = 0x8f
const JUMPI = 0x57

// R9: opcodes whose presence lets an implementation behave differently after the simulation
// (time bombs, tx.origin gates, external flags, delegatecall to attacker code, self-destruct).
export const DANGEROUS_OPCODES = {
  0x32: 'ORIGIN',
  0x40: 'BLOCKHASH',
  0x41: 'COINBASE',
  0x42: 'TIMESTAMP',
  0x43: 'NUMBER',
  0x44: 'PREVRANDAO',
  0x5a: 'GAS',
  0xf0: 'CREATE',
  0xf1: 'CALL',
  0xf2: 'CALLCODE',
  0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2',
  0xfa: 'STATICCALL',
  0xff: 'SELFDESTRUCT',
}

export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(h.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

// End of executable code: strips the CBOR metadata tail (last 2 bytes = its length).
function codeEnd(code) {
  let end = code.length
  if (end >= 2) {
    const metaLen = (code[end - 2] << 8) | code[end - 1]
    if (metaLen + 2 <= end && code[end - metaLen - 2] === 0xa2) end = end - metaLen - 2
  }
  return end
}

/** Walk opcodes: cb(op, pc, pushLen) for every instruction; PUSH data is never visited as opcodes. */
export function walkOpcodes(code, cb) {
  const end = codeEnd(code)
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc]
    const n = op >= PUSH1 && op <= PUSH32 ? op - PUSH1 + 1 : 0
    cb(op, pc, n, end)
    pc += n
  }
}

const isDup = (b) => b >= DUP1 && b <= DUP16
const isCmp = (b) => b === EQ || b === GT || b === LT

export function extractSelectors(codeHex) {
  const code = hexToBytes(codeHex)
  const found = new Set()
  let prevOp = -1
  walkOpcodes(code, (op, pc, n, end) => {
    const before = prevOp
    prevOp = op
    if (n < 1 || n > 4 || pc + n + 1 >= end) return
    let k = pc + n + 1
    if (isDup(code[k]) && k + 1 < end) k++ // tolerate one DUPn between the push and the comparison
    if (!isCmp(code[k])) return
    if (n < 4) {
      // short push: require DUPn before it and PUSHm <dest> JUMPI after the comparison
      if (!isDup(before)) return
      const j = code[k + 1]
      if (!(j >= PUSH1 && j <= PUSH1 + 2)) return
      if (code[k + 1 + (j - PUSH1 + 1) + 1] !== JUMPI) return
    }
    const bytes = Array.from(code.slice(pc + 1, pc + 1 + n), (b) => b.toString(16).padStart(2, '0')).join('')
    const sel = bytes.padStart(8, '0')
    if (sel !== 'ffffffff' && sel !== '00000000') found.add('0x' + sel)
  })
  return [...found].sort()
}

/** Names of the R9 opcodes present in the executable part of the code (sorted). */
export function dangerousOpcodes(codeHex) {
  if (!codeHex || codeHex === '0x') return []
  const code = hexToBytes(codeHex)
  const found = new Set()
  walkOpcodes(code, (op) => {
    if (DANGEROUS_OPCODES[op]) found.add(DANGEROUS_OPCODES[op])
  })
  return [...found].sort()
}
