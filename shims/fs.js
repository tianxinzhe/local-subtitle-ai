export default {}
export const existsSync = () => false
export const readFileSync = () => null
export const readdirSync = () => []
export const writeFileSync = () => {}
export const mkdirSync = () => {}
export const statSync = () => ({ isDirectory: () => false, isFile: () => false })
export const createWriteStream = () => ({ write: () => {}, end: () => {} })
export const constants = {}
