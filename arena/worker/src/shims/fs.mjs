// node:fs stand-in for the Worker bundle. The sentinel/reporter modules we import only use fs inside
// their file loaders (rules.json, ABI files), which the Worker never calls with a path: config comes
// from src/generated/config.mjs instead.
export const existsSync = () => false
export function readFileSync() {
  throw new Error('node:fs is not available in the Arena Worker')
}
export default { existsSync, readFileSync }
