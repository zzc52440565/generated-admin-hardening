import { readFileSync } from 'node:fs'

// 值只由 conventions.json 维护；文档引用其字段，不保存另一套默认值。
export const conventions = JSON.parse(readFileSync(new URL('../references/conventions.json', import.meta.url), 'utf8'))
export const demoPassword = conventions.localDemo.password
