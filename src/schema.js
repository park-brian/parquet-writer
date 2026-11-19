import { compileLeaf, normalize } from './pages.js'

/** @typedef {import('./pages.js').Field} Field */
/** @typedef {import('./pages.js').Leaf} Leaf */
/** @typedef {import('./pages.js').Value} Value */
/** @typedef {{name: string, repetition: number, leaf?: Leaf, children?: number, logical?: 'list' | 'map'}} Element */
/** @typedef {{field: Field, children: Node[], definition: number, repetition: number, firstLeaf: number, endLeaf: number, leaf?: Leaf}} Node */
/** @typedef {(index: number, value: Value, definition: number, repetition: number) => void} Emit */

/** @param {import('./pages.js').Schema} schema */
export function compileSchema(schema) {
  /** @type {Leaf[]} */
  const leaves = []
  /** @type {Element[]} */
  const elements = [{ name: 'schema', repetition: 0, children: schema?.fields?.length }]
  const active = new Set()

  /** @param {Field[]} fields @param {string[]} path @param {number} def @param {number} rep */
  function siblings(fields, path, def, rep) {
    if (!Array.isArray(fields) || !fields.length) throw new TypeError('Expected nonempty schema fields')
    const names = new Set()
    return fields.map(field => {
      if (typeof field?.name !== 'string' || !field.name || names.has(field.name)) throw new TypeError('Expected unique field names')
      names.add(field.name)
      return node(field, path, def, rep)
    })
  }

  /** @param {Field} field @param {string[]} parent @param {number} def @param {number} rep @param {object} identity @returns {Node} */
  function node(field, parent, def, rep, identity = field) {
    if (!field || active.has(identity)) throw new TypeError('Invalid or cyclic schema')
    active.add(identity)
    const { name, type, nullable = true } = field
    const path = [...parent, name]
    const definition = def + Number(nullable)
    const firstLeaf = leaves.length
    const element = /** @type {Element} */ ({ name, repetition: nullable ? 1 : 0 })
    elements.push(element)
    let nodeRep = rep
    /** @type {Node[]} */
    let children = []
    if (type === 'struct') {
      element.children = field.fields.length
      children = siblings(field.fields, path, definition, rep)
    } else if (type === 'list' || type === 'map') {
      element.logical = type
      element.children = 1
      const wrapper = type === 'list' ? 'list' : 'key_value'
      nodeRep++
      elements.push({ name: wrapper, repetition: 2, children: type === 'list' ? 1 : 2 })
      if (type === 'map' && (!field.key || ['float', 'double', 'struct', 'list', 'map'].includes(field.key.type))) {
        throw new TypeError('Expected a non-floating scalar map key')
      }
      const wrapperPath = [...path, wrapper]
      if (type === 'list') {
        children = [node({ ...field.element, name: 'element' }, wrapperPath, definition + 1, nodeRep, field.element)]
      } else {
        children = [
          node({ ...field.key, name: 'key', nullable: false }, wrapperPath, definition + 1, nodeRep, field.key),
          node({ ...field.value, name: 'value' }, wrapperPath, definition + 1, nodeRep, field.value),
        ]
      }
    } else {
      const leaf = compileLeaf(field)
      leaf.path = path
      leaf.definitionWidth = 32 - Math.clz32(definition)
      leaf.repetitionWidth = 32 - Math.clz32(rep)
      element.leaf = leaf
      leaves.push(leaf)
    }
    active.delete(identity)
    return { field, children, definition, repetition: nodeRep, firstLeaf, endLeaf: leaves.length, leaf: element.leaf }
  }

  return { roots: siblings(schema?.fields, [], 0, 0), elements, leaves }
}

/** @param {Node} node @param {unknown} input @param {number} def @param {number} rep @param {Emit} emit @param {Set<object>} active */
export function shred(node, input, def, rep, emit, active) {
  const { field, children, leaf, definition, repetition, firstLeaf, endLeaf } = node
  const name = field.name

  /** @param {number} level */
  function absent(level) {
    for (let i = firstLeaf; i < endLeaf; i++) emit(i, null, level, rep)
  }

  if (input == null) {
    if (field.nullable === false) throw new TypeError('Missing required field ' + name)
    absent(def)
    return
  }
  if (leaf) {
    emit(firstLeaf, normalize(leaf, input), definition, rep)
    return
  }
  if (typeof input !== 'object' || active.has(input)) throw new TypeError('Invalid or cyclic nested value for ' + name)
  active.add(input)
  switch (field.type) {
    case 'struct': {
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new TypeError('Expected a struct for ' + name)
      }
      for (const key of Object.keys(input)) {
        if (!children.some(child => child.field.name === key)) throw new TypeError('Unknown struct field ' + key)
      }
      const record = /** @type {Record<string, unknown>} */ (input)
      for (const child of children) {
        const key = child.field.name
        shred(child, Object.hasOwn(record, key) ? record[key] : undefined, definition, rep, emit, active)
      }
      break
    }
    case 'list':
      if (!Array.isArray(input)) throw new TypeError('Expected an array for ' + name)
      if (!input.length) absent(definition)
      for (let i = 0; i < input.length; i++) {
        if (!Object.hasOwn(input, i)) throw new TypeError('Sparse lists are unsupported')
        shred(children[0], input[i], definition + 1, i ? repetition : rep, emit, active)
      }
      break
    case 'map': {
      if (!(input instanceof Map)) throw new TypeError('Expected a Map for ' + name)
      if (!input.size) absent(definition)
      let entryRep = rep
      const keys = new Set()
      const keyNode = children[0]
      const keyLeaf = /** @type {Leaf} */ (keyNode.leaf)
      for (const [key, value] of input) {
        const normalized = normalize(keyLeaf, key)
        const identity = normalized instanceof Uint8Array ? normalized.join(',') : normalized
        if (keys.has(identity)) throw new TypeError('Duplicate encoded map key for ' + name)
        keys.add(identity)
        emit(keyNode.firstLeaf, normalized, keyNode.definition, entryRep)
        shred(children[1], value, definition + 1, entryRep, emit, active)
        entryRep = repetition
      }
      break
    }
  }
  active.delete(input)
}
