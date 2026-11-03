import { TextDecoder } from 'node:util'

export interface NrbfObject { type: string; members: Map<string, NrbfValue> }
interface Reference { reference: number }
interface NullRun { nulls: number }
interface MemberType { type: number; primitive?: number }
interface Metadata { type: string; names: string[]; types: MemberType[] }
export type NrbfValue = null | string | number | boolean | bigint | Buffer | NrbfObject | NrbfValue[] | Reference

const MAX_ITEMS = 100_000
const MAX_DEPTH = 64
const END = Symbol('end')
const utf8 = new TextDecoder('utf-8', { fatal: true })

export function decodeNrbf(bytes: Buffer): { root: NrbfValue; objects: Map<number, NrbfValue>; consumed: number } {
  let offset = 0
  let operations = 0
  let allocated = 0
  const objects = new Map<number, NrbfValue>()
  const metadata = new Map<number, Metadata>()
  const references: number[] = []
  const fail = (): never => { throw new Error('RDO 二进制数据无效、已损坏或包含暂不支持的结构') }
  const consume = (length: number): Buffer => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) return fail()
    const value = bytes.subarray(offset, offset + length)
    offset += length
    return value
  }
  const byte = () => consume(1)[0]!
  const int = () => consume(4).readInt32LE()
  const count = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ITEMS || (allocated += value) > 500_000) return fail()
    return value
  }
  const text = (): string => {
    let length = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      const next = byte()
      if (shift === 28 && next > 7) return fail()
      length += (next & 127) * 2 ** shift
      if (!(next & 128)) {
        if (length > 1024 * 1024) return fail()
        return utf8.decode(consume(length))
      }
    }
    return fail()
  }
  const store = (id: number, value: NrbfValue): NrbfValue => {
    if (!id || objects.has(id) || objects.size >= MAX_ITEMS) return fail()
    objects.set(id, value)
    return value
  }
  const primitive = (type: number): NrbfValue => {
    switch (type) {
      case 1: { const value = byte(); if (value > 1) return fail(); return !!value }
      case 2: return byte()
      case 3: {
        const first = byte()
        const length = first < 128 ? 1 : first >= 194 && first < 224 ? 2 : first < 240 && first >= 224 ? 3 : 0
        if (!length) return fail()
        return utf8.decode(Buffer.concat([Buffer.from([first]), consume(length - 1)]))
      }
      case 5: return text()
      case 6: return consume(8).readDoubleLE()
      case 7: return consume(2).readInt16LE()
      case 8: return int()
      case 9: case 12: case 13: return consume(8).readBigInt64LE()
      case 10: return consume(1).readInt8()
      case 11: return consume(4).readFloatLE()
      case 14: return consume(2).readUInt16LE()
      case 15: return consume(4).readUInt32LE()
      case 16: return consume(8).readBigUInt64LE()
      default: return fail()
    }
  }
  const memberType = (type: number): MemberType => {
    if (type < 0 || type > 7) return fail()
    if (type === 0 || type === 7) return { type, primitive: byte() }
    if (type === 3) text()
    if (type === 4) { text(); int() }
    return { type }
  }
  const objectValue = (depth: number): NrbfValue => {
    const value = record(depth)
    if (value === END || value && typeof value === 'object' && 'nulls' in value) return fail()
    return value
  }
  const classValues = (id: number, description: Metadata, depth: number): NrbfValue => {
    const value: NrbfObject = { type: description.type, members: new Map() }
    store(id, value)
    description.names.forEach((name, index) => {
      const field = description.types[index]!
      value.members.set(name, field.type === 0 ? primitive(field.primitive!) : objectValue(depth + 1))
    })
    return value
  }
  const arrayValues = (id: number, length: number, type: MemberType, depth: number): NrbfValue => {
    if (type.type === 0 && type.primitive === 2) return store(id, Buffer.from(consume(length)))
    const values: NrbfValue[] = []
    store(id, values)
    while (values.length < length) {
      const value = type.type === 0 ? primitive(type.primitive!) : record(depth + 1)
      if (value === END) return fail()
      if (value && typeof value === 'object' && 'nulls' in value) {
        if (value.nulls < 1 || value.nulls > length - values.length) return fail()
        for (let index = 0; index < value.nulls; index++) values.push(null)
      } else values.push(value)
    }
    return values
  }
  const record = (depth: number): NrbfValue | NullRun | typeof END => {
    if (depth > MAX_DEPTH || ++operations > 500_000) return fail()
    let tag = byte()
    while (tag === 12) {
      int(); text()
      if (++operations > 500_000) return fail()
      tag = byte()
    }
    switch (tag) {
      case 1: {
        const id = int()
        const description = metadata.get(int())
        if (!description) return fail()
        return classValues(id, description, depth)
      }
      case 2: case 3: case 4: case 5: {
        const id = int()
        const type = text()
        const length = count(int())
        const names: string[] = []
        for (let index = 0; index < length; index++) names.push(text())
        if (new Set(names).size !== names.length) return fail()
        const typeCodes: number[] = []
        for (let index = 0; index < length; index++) typeCodes.push(tag >= 4 ? byte() : 2)
        const types = typeCodes.map(memberType)
        if (tag === 3 || tag === 5) int()
        const description = { type, names, types }
        metadata.set(id, description)
        return classValues(id, description, depth)
      }
      case 6: { const id = int(); return store(id, text()) }
      case 7: {
        const id = int()
        const arrayType = byte()
        const rank = int()
        if (arrayType > 5 || rank < 1 || rank > 4) return fail()
        let length = 1
        for (let dimension = 0; dimension < rank; dimension++) {
          const size = int()
          if (size < 0 || size > MAX_ITEMS || length * size > MAX_ITEMS) return fail()
          length *= size
        }
        count(length)
        if (arrayType >= 3) for (let dimension = 0; dimension < rank; dimension++) if (int() !== 0) return fail()
        return arrayValues(id, length, memberType(byte()), depth)
      }
      case 8: return primitive(byte())
      case 9: { const reference = int(); references.push(reference); return { reference } }
      case 10: return null
      case 11: return END
      case 13: return { nulls: byte() }
      case 14: return { nulls: int() }
      case 15: case 16: case 17: {
        const id = int()
        const length = count(int())
        return arrayValues(id, length, tag === 15 ? { type: 0, primitive: byte() } : { type: tag === 17 ? 1 : 2 }, depth)
      }
      default: return fail()
    }
  }

  if (bytes.length < 17 || bytes.length > 8 * 1024 * 1024 || byte() !== 0) return fail()
  const rootId = int()
  int()
  if (int() !== 1 || int() !== 0) return fail()
  while (record(0) !== END) {}
  const root = objects.get(rootId)
  if (root === undefined || references.some(id => !objects.has(id))) return fail()
  return { root, objects, consumed: offset }
}

export function dereferenceNrbf(value: NrbfValue | undefined, objects: Map<number, NrbfValue>): NrbfValue | undefined {
  const visited = new Set<number>()
  while (value && typeof value === 'object' && 'reference' in value) {
    if (visited.has(value.reference)) throw new Error('RDO 包含循环对象引用')
    visited.add(value.reference)
    value = objects.get(value.reference)
  }
  return value
}

export function isNrbfObject(value: NrbfValue | undefined): value is NrbfObject {
  return !!value && typeof value === 'object' && 'members' in value
}
