export const nestedSchema = { fields: [
  { name: 'id', type: 'int32', nullable: false },
  { name: 'numbers', type: 'list', element: { type: 'int32' } },
  { name: 'matrix', type: 'list', element: { type: 'list', element: { type: 'int32' } } },
  { name: 'record', type: 'struct', fields: [
    { name: 'a.b', type: 'string', nullable: false },
    { name: 'items', type: 'list', element: { type: 'struct', fields: [
      { name: 'flag', type: 'boolean', nullable: false },
    ] } },
  ] },
  { name: 'attributes', type: 'map', key: { type: 'string' }, value: { type: 'int32' } },
] }

export const nestedRows = [
  { id: 0, numbers: null, matrix: null, record: null, attributes: null },
  { id: 1, numbers: [], matrix: [], record: { 'a.b': 'empty', items: [] }, attributes: new Map() },
  { id: 2, numbers: [1, null, 2], matrix: [[1, 2], [], null, [null, 3]],
    record: { 'a.b': 'full', items: [null, { flag: false }, { flag: true }] },
    attributes: new Map([['a', null], ['b', 2]]) },
]
