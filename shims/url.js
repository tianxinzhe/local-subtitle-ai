export default {}
export const fileURLToPath = (url) => typeof url === 'string' ? url.replace(/^file:\/\//, '') : ''
export const pathToFileURL = (path) => new URL('file://' + path)
export const URL = globalThis.URL
