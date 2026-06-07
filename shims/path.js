export default {}
export const join = (...args) => args.join('/')
export const dirname = (p) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : '.' }
export const basename = (p) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p }
export const extname = (p) => { const i = p.lastIndexOf('.'); return i >= 0 ? p.slice(i) : '' }
export const resolve = (...args) => args.join('/')
export const sep = '/'
export const delimiter = ':'
export const relative = (from, to) => to
